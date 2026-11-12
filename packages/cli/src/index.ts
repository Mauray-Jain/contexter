#!/usr/bin/env -S npx tsx
import { Command, Option } from "commander";
import { check, CliError, getClient, requireUser, requireWorkspace } from "./client.ts";
import { loadConfig, saveConfig } from "./config.ts";
import { loginWithEmail, loginWithGithub } from "./auth.ts";
import { templates } from "./templates.ts";

const program = new Command("contexter")
  .description("Shared context and reasoning for teams using Claude on separate accounts");

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
    console.log(`Joined "${ws.slug}" as ${handle}. It's now active.`);
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
    await requireUser(sb);
    const ws = check(await sb.from("workspaces").select("id, slug").eq("slug", slug).maybeSingle());
    if (!ws) throw new CliError(`No workspace "${slug}" that you're a member of`);
    saveConfig({ activeWorkspace: ws as { id: string; slug: string } });
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
  .option("--limit <n>", "max events", "100")
  .action(async ({ limit }) => {
    const sb = getClient();
    await requireUser(sb);
    const ws = requireWorkspace();
    const [events, members] = await Promise.all([
      sb.rpc("pull_feed", { p_workspace: ws.id, p_limit: Number(limit) }),
      sb.from("members").select("user_id, handle").eq("workspace_id", ws.id),
    ]);
    const handles = new Map((check(members) as any[]).map((m) => [m.user_id, m.handle]));
    const rows = check(events) as any[];
    if (!rows.length) return console.log("Nothing new from your teammates.");
    for (const e of rows) {
      const who = handles.get(e.author_id) ?? "someone";
      const when = new Date(e.created_at).toLocaleString();
      console.log(`• ${who} · ${when} · ${e.kind}: ${describe(e)}`);
    }
  });

function describe(e: { kind: string; payload: any }): string {
  const p = e.payload ?? {};
  switch (e.kind) {
    case "edit": return `${p.collection}/${p.key} v${p.from}→v${p.to}: ${p.summary}`;
    case "lock": return `${p.action} ${p.collection ? `${p.collection}/${p.key}` : p.unit}${p.reason ? ` (${p.reason})` : ""}`;
    case "record": return `${p.type} #${p.number}: ${p.title}`;
    case "member": return `${p.handle} ${p.action} the workspace`;
    default: return JSON.stringify(p);
  }
}

program.parseAsync().catch((err) => {
  console.error(err instanceof CliError ? `error: ${err.message}` : err);
  process.exit(1);
});
