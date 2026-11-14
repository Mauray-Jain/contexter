#!/usr/bin/env node
import { Argument, Command, Option } from "commander";
import { check, CliError, getClient, requireUser, requireWorkspace } from "./client.ts";
import { loadConfig, saveConfig } from "./config.ts";
import { loginWithEmail, loginWithGithub } from "./auth.ts";
import { templates } from "./templates.ts";
import { acceptInvites, createTeam, handleFromEmail, inviteByEmail, listInvites, listTeams, removeMember, resolveTeam, revokeInvite, setDefault, setRole, showTeam, transferOwnership } from "./team.ts";
import * as core from "../../../supabase/functions/_shared/contexter.ts";
import { runHook } from "./hooks.ts";
import { chatInstructions, installCode, packageSkill, uninstallCode } from "./install.ts";
import { cliCtx, exportWorkspace, mirror, watch } from "./workspace.ts";
import { runJob } from "./run.ts";
import { activeModalProfile, ensureModalDaemon, modalDaemon } from "./modal.ts";
import { linkedWorkspace, projectRoot, projectWorkspace } from "./hooks.ts";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const program = new Command("contexter")
  .description("Shared context and reasoning for teams using Claude on separate accounts")
  .enablePositionalOptions(); // lets `contexter run` pass the job's own options through

program.command("setup")
  .description("Point this machine at your team's Supabase project")
  .requiredOption("--url <url>", "Supabase project URL")
  .requiredOption("--key <key>", "Supabase publishable (anon) key")
  .action(({ url, key }) => {
    saveConfig({ url, publishableKey: key });
    console.log(`Configured for ${url}`);
  });

program.command("login")
  .description("Sign in (GitHub by default)")
  .option("--email <address>", "sign in with an emailed one-time code instead")
  .option("--code <code>", "the one-time code, for non-interactive use")
  .action(async ({ email, code }) => {
    const sb = getClient();
    const user = email ? await loginWithEmail(sb, email, code) : await loginWithGithub(sb);
    console.log(`Signed in as ${user.email ?? user.id}`);
  });

program.command("logout").description("Sign out on this machine").action(async () => {
  await getClient().auth.signOut({ scope: "local" });
  console.log("Signed out");
});

program.command("whoami").description("Show the signed-in user and active workspace").action(async () => {
  const user = await requireUser(getClient());
  const ws = loadConfig().activeWorkspace;
  console.log(`${user.email ?? user.id}${ws ? ` · workspace: ${ws.slug}` : ""}`);
});

program.command("init")
  .description("Create a project and make it active (in a team: --team)")
  .argument("<slug>", "short id, e.g. retrieval-paper")
  .option("--handle <handle>", "your name in this project, e.g. mauray (derived from your email when omitted)")
  .option("--name <name>", "display name (defaults to slug)")
  .addOption(new Option("--template <template>", "starting structure")
    .choices(Object.keys(templates)).default("blank"))
  .option("--team <slug>", "create it in one of your teams (you must administer it)")
  .action(async (slug, { handle, name, template, team }) => {
    const sb = getClient();
    const user = await requireUser(sb);
    let ws: { id: string; slug: string };
    if (team) {
      // Same path as the web: the server seeds the template and applies the team's defaults.
      const t = await resolveTeam(sb, team);
      ws = check(await sb.rpc("create_team_project", { p_team: t.id, p_slug: slug, p_name: name ?? slug, p_template: template })
        .single<{ id: string; slug: string }>());
    } else {
      const tpl = templates[template];
      ws = check(await sb.rpc("create_workspace", {
        p_slug: slug, p_name: name ?? slug, p_handle: handle ?? handleFromEmail(user.email ?? "me"), p_template: template, p_manifest: tpl.manifest,
      }).single<{ id: string; slug: string }>());
      if (tpl.units.length) check(await sb.from("units").insert(tpl.units.map((u) => ({ ...u, workspace_id: ws.id }))));
    }
    saveConfig({ activeWorkspace: { id: ws.id, slug: ws.slug } });
    await core.setActiveWorkspace(sb, user.id, ws.id);
    console.log(`Created workspace "${ws.slug}" from template ${template} (${templates[template].units.length} units)${team ? ` in team ${team}` : ""}. It's now active.`);
    console.log(team ? `Invite teammates with: contexter invite name@company.com` : "Invite teammates with: contexter invite");
  });

program.command("invite")
  .description("Invite people by email to the active project's team, or print an invite code when no emails are given")
  .argument("[emails...]", "email addresses to invite")
  .option("--team <slug>", "the team to invite to (defaults to the active project's team)")
  .option("-p, --project <slugs...>", "projects to give access to (defaults to the active project)")
  .option("--admin", "invite as team admins (team owners only)")
  .addOption(new Option("--role <role>", "project role (and the code's role)").choices(["editor", "viewer"]).default("editor"))
  .option("--uses <n>", "code only: how many people can use it", "1")
  .option("--days <n>", "code only: days until it expires", "7")
  .action(async (emails: string[], { role, uses, days, team, project, admin }) => {
    if (emails.length) return inviteByEmail(emails, { team, project, role, admin });
    const sb = getClient();
    await requireUser(sb);
    const ws = requireWorkspace();
    const expires = new Date(Date.now() + Number(days) * 86_400_000).toISOString();
    const inv = check(await sb.from("invites")
      .insert({ workspace_id: ws.id, role, max_uses: Number(uses), expires_at: expires })
      .select("code").single<{ code: string }>());
    console.log(`Invite code (${role}, ${uses} use(s), ${days} days):\n\n  ${inv.code}\n`);
    console.log(`Teammates run: contexter join ${inv.code}`);
    console.log("Tip: invite by email instead with: contexter invite name@company.com");
  });

program.command("join")
  .description("Accept your pending email invitations, or join with an invite code")
  .argument("[code]", "an invite code; omit it to accept invitations sent to your email")
  .option("--handle <handle>", "your name in the project (derived from your email when omitted)")
  .action(async (code: string | undefined, { handle }) => {
    if (!code) return acceptInvites();
    const sb = getClient();
    const user = await requireUser(sb);
    const name = handle ?? handleFromEmail(user.email ?? "me");
    const ws = check(await sb.rpc("join_workspace", { p_code: code, p_handle: name })
      .single<{ id: string; slug: string }>());
    saveConfig({ activeWorkspace: { id: ws.id, slug: ws.slug } });
    await core.setActiveWorkspace(sb, user.id, ws.id);
    console.log(`Joined "${ws.slug}" as ${name}. It's now active.`);
  });

const teamCmd = program.command("team").description("Your teams: people, roles, invitations and defaults")
  .option("--team <slug>", "which team (defaults to the active project's team)")
  .action(async ({ team }) => showTeam(team));
teamCmd.command("list").description("Teams you belong to").action(() => listTeams());
teamCmd.command("show").description("Projects, people and their access, and who is waiting to join").argument("[slug]")
  .action((slug?: string) => showTeam(slug ?? teamCmd.opts().team));
teamCmd.command("create").description("Create a team; you become its owner").argument("<slug>").option("--name <name>", "display name")
  .action((slug: string, { name }) => createTeam(slug, name));
teamCmd.command("role").description("Change someone's team role (team owners only)").argument("<email>")
  .addArgument(new Argument("<role>").choices(["owner", "admin", "member"])).option("--team <slug>", "which team")
  .action((email: string, role: string, o) => setRole(email, role, { team: o.team ?? teamCmd.opts().team }));
teamCmd.command("remove").description("Remove someone from the team, with the project access the team gave them (your own email leaves)")
  .argument("<email>").option("--team <slug>", "which team").action((email: string, o) => removeMember(email, { team: o.team ?? teamCmd.opts().team }));
teamCmd.command("invites").description("Invitations waiting to be accepted").option("--team <slug>", "which team").action((o) => listInvites({ team: o.team ?? teamCmd.opts().team }));
teamCmd.command("revoke").description("Revoke a pending invitation").argument("<email>").option("--team <slug>", "which team").action((email: string, o) => revokeInvite(email, { team: o.team ?? teamCmd.opts().team }));
teamCmd.command("default").description("What new members get: every project (all) or only what they're invited to (none)")
  .addArgument(new Argument("<access>").choices(["all", "none"])).option("--team <slug>", "which team").action((access: string, o) => setDefault(access, { team: o.team ?? teamCmd.opts().team }));

program.command("transfer")
  .description("Make someone else the owner of the active project (or --workspace); you stay on as an editor")
  .argument("<email>")
  .option("-w, --workspace <slug>", "the project (defaults to the active one)")
  .action((email: string, { workspace }) => transferOwnership(email, { workspace }));

program.command("templates").description("List workspace templates").action(() => {
  for (const [name, t] of Object.entries(templates)) console.log(`${name.padEnd(16)} ${t.description}`);
});

program.command("workspaces").description("List your workspaces").action(async () => {
  const sb = getClient();
  const user = await requireUser(sb);
  const rows = check(await sb.from("members")
    .select("handle, role, workspaces(slug, name, template)").eq("user_id", user.id));
  const active = loadConfig().activeWorkspace?.slug;
  for (const r of rows as any[]) {
    const w = r.workspaces;
    console.log(`${w.slug === active ? "*" : " "} ${w.slug.padEnd(24)} ${w.template.padEnd(16)} ${r.role.padEnd(7)} as ${r.handle}`);
  }
});

program.command("use")
  .description("Switch the active workspace")
  .argument("<slug>")
  .action(async (slug) => {
    const sb = getClient();
    const user = await requireUser(sb);
    const ws = check(await sb.from("workspaces").select("id, slug").eq("slug", slug).maybeSingle());
    if (!ws) throw new CliError(`No workspace "${slug}" that you're a member of`);
    saveConfig({ activeWorkspace: ws as { id: string; slug: string } });
    await core.setActiveWorkspace(sb, user.id, (ws as { id: string }).id);
    console.log(`Active workspace: ${slug}`);
  });

program.command("status").description("Members, units and locks in the active workspace").action(async () => {
  const sb = getClient();
  await requireUser(sb);
  const ws = requireWorkspace();
  const [members, units] = await Promise.all([
    sb.from("members").select("user_id, handle, role").eq("workspace_id", ws.id).order("joined_at"),
    sb.from("units").select("collection, key, status, current_version, lock_holder, lock_expires_at")
      .eq("workspace_id", ws.id).order("collection").order("position", { nullsFirst: false }).order("key"),
  ]);
  const handles = new Map((check(members) as any[]).map((m) => [m.user_id, m.handle]));

  console.log(`Workspace ${ws.slug}\n\nMembers`);
  for (const m of check(members) as any[]) console.log(`  ${m.handle.padEnd(16)} ${m.role}`);
  console.log("\nUnits");
  for (const u of check(units) as any[]) {
    const locked = u.lock_holder && new Date(u.lock_expires_at) > new Date()
      ? `  🔒 ${handles.get(u.lock_holder) ?? "?"} until ${new Date(u.lock_expires_at).toLocaleTimeString()}` : "";
    console.log(`  ${`${u.collection}/${u.key}`.padEnd(32)} ${u.status.padEnd(9)} v${u.current_version}${locked}`);
  }
});

program.command("feed")
  .description("Show teammates' activity since you last looked (advances your cursor)")
  .action(async () => {
    const out = await core.feedDelta(await cliCtx());
    console.log(out || "Nothing new from your teammates.");
  });

program.command("memory").description("Show the team's shared memory and everything since").action(async () => {
  console.log(await core.memoryContext(await cliCtx()));
});

program.command("search").description("Search units, reasoning and the feed").argument("<query...>")
  .action(async (query: string[]) => console.log(await core.search(await cliCtx(), query.join(" "))));

program.command("why").description("Explain a unit or record from its reasoning and history")
  .argument("<target>", "unit ref (sections/method), record ref (D-0007) or a question")
  .action(async (target) => console.log(await core.why(await cliCtx(), target)));

program.command("export")
  .description("Export the workspace (ordered units) with pandoc")
  .addOption(new Option("--format <format>").choices(["md", "pdf", "docx", "html", "tex", "epub"]).default("md"))
  .option("--collection <name>", "only this collection (research-paper defaults to sections)")
  .option("--with-reasoning", "append the reasoning record as an appendix")
  .option("-o, --out <file>")
  .action(async (opts) => console.log(`Wrote ${await exportWorkspace(opts)}`));

program.command("mirror")
  .description("Back up the workspace as files in a git repo (units, records, memory)")
  .argument("<dir>")
  .action(async (dir) => console.log(await mirror(dir)));

program.command("watch")
  .description("Live team feed in this terminal")
  .option("--notify", "also show desktop notifications")
  .action(async (opts) => watch(opts));

program.command("run")
  .description("Run a long job and keep the team posted: progress, log tail and exit code, with a heartbeat every minute")
  .argument("<command...>", "the command, after --; one quoted argument runs through the shell")
  .option("-t, --title <title>", "what it is (defaults to the command)")
  .option("--host <name>", "machine name to show (defaults to this host)")
  .option("-w, --watch <handles...>", "teammates who should follow it and hear when it ends")
  .passThroughOptions()
  .action((command: string[], opts) => runJob(command, opts));

program.command("runs")
  .description("The workspace's runs, or one run with its log tail")
  .argument("[number]", "a run number")
  .option("-w, --watch [handles...]", "watch this run yourself, or have these teammates follow it")
  .action(async (number: string | undefined, opts: { watch?: true | string[] }) => {
    const ctx = await cliCtx(projectWorkspace(process.cwd()));
    if (!number) return console.log(await core.listRuns(ctx));
    const n = Number(number.replace(/^#/, ""));
    if (opts.watch) console.log(await core.watchRun(ctx, n, opts.watch === true ? [] : opts.watch.map((h) => h.replace(/^@/, ""))));
    console.log(await core.runDetail(ctx, n));
  });

const modal = program.command("modal").description("Watch Modal jobs that run detached from this machine");
modal.command("track")
  .description("Have this machine watch a detached Modal job (reports progress, log tail and the end to the team)")
  .argument("<app-id>", "the Modal app id, ap-…")
  .option("-t, --title <title>", "what it is (for a new run)")
  .option("--run <number>", "attach the job to this existing run instead of starting a new one")
  .option("--profile <name>", "Modal profile it runs under (defaults to your active profile)")
  .option("--env <name>", "Modal environment, if not the default")
  .option("-w, --watch <handles...>", "teammates who should follow it")
  .action(async (appId: string, opts: { title?: string; run?: string; profile?: string; env?: string; watch?: string[] }) => {
    const ctx = await cliCtx(projectWorkspace(process.cwd()));
    const job = { app_id: appId, profile: opts.profile ?? activeModalProfile(), environment: opts.env };
    const run = opts.run
      ? await core.getRun(ctx, Number(opts.run.replace(/^#/, "")))
      : await core.startRun(ctx, {
        title: opts.title ?? `Modal ${appId}`, host: "Modal", reporter: "modal",
        watchers: (opts.watch ?? []).map((h) => h.replace(/^@/, "")),
      });
    await core.setRunModal(ctx, run.id, job, true);
    await ensureModalDaemon(ctx.db, ctx.userId, process.cwd());
    console.log(`This machine now watches ${appId} as run #${run.number}${job.profile ? ` (profile ${job.profile})` : ""}. ` +
      "The watcher runs in the background and stops once nothing is left to watch.");
  });
modal.command("daemon")
  .description("Run the Modal watcher in the foreground (Claude Code's hooks start it in the background)")
  .action(() => modalDaemon());

program.command("handoffs")
  .description("Open handoffs you could take over, or accept/decline one")
  .argument("[number]", "a handoff number")
  .addOption(new Option("--accept").conflicts("decline"))
  .option("--decline")
  .action(async (number: string | undefined, opts: { accept?: boolean; decline?: boolean }) => {
    const ctx = await cliCtx(projectWorkspace(process.cwd()));
    if (number && (opts.accept || opts.decline)) {
      console.log(await core.resolveHandoff(ctx, Number(number.replace(/^#/, "")), opts.accept ? "accept" : "decline"));
      if (opts.accept && await ensureModalDaemon(ctx.db, ctx.userId, process.cwd())) {
        console.log("Started this machine's Modal watcher in the background.");
      }
      return;
    }
    console.log(await core.handoffsBlock(ctx) || "No open handoffs for you.");
  });

const install = program.command("install").description("Connect Claude to contexter");
install.command("code")
  .description("Claude Code: hooks (automatic sync every message) + skill")
  .addOption(new Option("--scope <scope>").choices(["user", "project"]).default("project"))
  .option("--workspace <slug>", "link this folder to a workspace (project scope)")
  .action((opts) => console.log(installCode({ ...opts, cwd: process.cwd() })));
install.command("chat")
  .description("Claude chat (desktop/web/mobile): package the skill and print connector steps")
  .option("-o, --out <file>", "where to write the skill zip", "contexter-skill.zip")
  .action(({ out }) => console.log(chatInstructions(packageSkill(out))));
program.command("uninstall").description("Remove contexter hooks and skill from Claude Code")
  .addOption(new Option("--scope <scope>").choices(["user", "project"]).default("project"))
  .action((opts) => console.log(uninstallCode({ ...opts, cwd: process.cwd() })));

// Claude Code sessions only join a workspace from a linked folder, so each project sees its own tasks.
program.command("link")
  .description("Link this folder (a project) to a workspace, so Claude Code sessions here join it")
  .argument("<slug>")
  .action(async (slug) => {
    const sb = getClient();
    await requireUser(sb);
    const ws = check(await sb.from("workspaces").select("slug").eq("slug", slug).maybeSingle());
    if (!ws) throw new CliError(`No workspace "${slug}" that you're a member of`);
    writeFileSync(join(process.cwd(), ".contexter.json"), `${JSON.stringify({ workspace: slug }, null, 2)}\n`);
    console.log(`Linked ${process.cwd()} to workspace "${slug}". New Claude Code sessions here join it.`);
  });
program.command("unlink")
  .description("Unlink this folder: Claude Code sessions here stop sharing with any workspace")
  .action(() => {
    const here = process.cwd();
    const root = projectRoot(here);
    if (!linkedWorkspace(here)) throw new CliError("This folder isn't linked to a workspace");
    // Only this folder changes. Opt it out when it inherits a parent's link (the parent and its other
    // folders stay linked) or removing its link would fall back to a parent's or CONTEXTER_WORKSPACE.
    const parent = dirname(here) !== here ? projectRoot(dirname(here)) : undefined;
    if (root !== here || (parent && linkedWorkspace(parent)) || process.env.CONTEXTER_WORKSPACE) {
      writeFileSync(join(here, ".contexter.json"), `${JSON.stringify({ workspace: null }, null, 2)}\n`);
    } else {
      rmSync(join(here, ".contexter.json"));
    }
    console.log(`Unlinked ${here}.`);
  });

program.command("hook", { hidden: true })
  .argument("<event>", "session-start | user-prompt-submit | stop | session-end")
  .action((event) => runHook(event));

program.parseAsync().catch((err) => {
  console.error(err instanceof CliError || err instanceof core.ContexterError ? `error: ${err.message}` : err);
  process.exit(1);
});
