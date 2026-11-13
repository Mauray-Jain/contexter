#!/usr/bin/env node
import { Command, Option } from "commander";
import { check, CliError, getClient, requireUser, requireWorkspace } from "./client.ts";
import { loadConfig, saveConfig } from "./config.ts";
import { loginWithEmail, loginWithGithub } from "./auth.ts";
import { templates } from "./templates.ts";
import * as core from "../../../supabase/functions/_shared/contexter.ts";
import { runHook } from "./hooks.ts";
import { chatInstructions, installCode, packageSkill, uninstallCode } from "./install.ts";
import { cliCtx, exportWorkspace, mirror, watch } from "./workspace.ts";
import { runJob } from "./run.ts";
import { projectWorkspace } from "./hooks.ts";

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
  .description("Create a workspace and make it active")
  .argument("<slug>", "short id, e.g. retrieval-paper")
  .requiredOption("--handle <handle>", "your name in this workspace, e.g. mauray")
  .option("--name <name>", "display name (defaults to slug)")
  .addOption(new Option("--template <template>", "starting structure")
    .choices(Object.keys(templates)).default("blank"))
  .action(async (slug, { handle, name, template }) => {
    const sb = getClient();
    await requireUser(sb);
    const tpl = templates[template];
    const ws = check(await sb.rpc("create_workspace", {
      p_slug: slug, p_name: name ?? slug, p_handle: handle, p_template: template, p_manifest: tpl.manifest,
    }).single<{ id: string; slug: string }>());

    if (tpl.units.length) {
      check(await sb.from("units").insert(tpl.units.map((u) => ({ ...u, workspace_id: ws.id }))));
    }
    saveConfig({ activeWorkspace: { id: ws.id, slug: ws.slug } });
    await core.setActiveWorkspace(sb, (await requireUser(sb)).id, ws.id);
    console.log(`Created workspace "${ws.slug}" from template ${template} (${tpl.units.length} units). It's now active.`);
    console.log("Invite teammates with: contexter invite");
  });

program.command("invite")
  .description("Create an invite code for the active workspace (owners only)")
  .addOption(new Option("--role <role>").choices(["editor", "viewer"]).default("editor"))
  .option("--uses <n>", "how many people can use it", "1")
  .option("--days <n>", "days until it expires", "7")
  .action(async ({ role, uses, days }) => {
    const sb = getClient();
    await requireUser(sb);
    const ws = requireWorkspace();
    const expires = new Date(Date.now() + Number(days) * 86_400_000).toISOString();
    const inv = check(await sb.from("invites")
      .insert({ workspace_id: ws.id, role, max_uses: Number(uses), expires_at: expires })
      .select("code").single<{ code: string }>());
    console.log(`Invite code (${role}, ${uses} use(s), ${days} days):\n\n  ${inv.code}\n`);
    console.log(`Teammates run: contexter join ${inv.code} --handle <their-name>`);
  });

program.command("join")
  .description("Join a workspace with an invite code and make it active")
  .argument("<code>")
  .requiredOption("--handle <handle>", "your name in this workspace")
  .action(async (code, { handle }) => {
    const sb = getClient();
    await requireUser(sb);
    const ws = check(await sb.rpc("join_workspace", { p_code: code, p_handle: handle })
      .single<{ id: string; slug: string }>());
    saveConfig({ activeWorkspace: { id: ws.id, slug: ws.slug } });
    await core.setActiveWorkspace(sb, (await requireUser(sb)).id, ws.id);
    console.log(`Joined "${ws.slug}" as ${handle}. It's now active.`);
  });

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

program.command("handoffs")
  .description("Open handoffs you could take over, or accept/decline one")
  .argument("[number]", "a handoff number")
  .addOption(new Option("--accept").conflicts("decline"))
  .option("--decline")
  .action(async (number: string | undefined, opts: { accept?: boolean; decline?: boolean }) => {
    const ctx = await cliCtx(projectWorkspace(process.cwd()));
    if (number && (opts.accept || opts.decline)) {
      return console.log(await core.resolveHandoff(ctx, Number(number.replace(/^#/, "")), opts.accept ? "accept" : "decline"));
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

program.command("hook", { hidden: true })
  .argument("<event>", "session-start | user-prompt-submit | stop | session-end")
  .action((event) => runHook(event));

program.parseAsync().catch((err) => {
  console.error(err instanceof CliError || err instanceof core.ContexterError ? `error: ${err.message}` : err);
  process.exit(1);
});
