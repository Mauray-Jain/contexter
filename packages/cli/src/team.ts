// Team commands: email invitations, accepting them, and managing a team's people and access.
// Everything runs through the same database functions and Edge Function the web uses, as the
// signed-in user, so the CLI can do exactly what that person may do and nothing more.
import type { SupabaseClient } from "@supabase/supabase-js";
import { check, CliError, getClient, requireUser } from "./client.ts";
import { loadConfig, saveConfig } from "./config.ts";
import * as core from "../../../supabase/functions/_shared/contexter.ts";

type Team = { id: string; slug: string; name: string; new_member_access: string };
type Overview = {
  projects: { id: string; slug: string; name: string; template: string; members: number }[];
  roster: { user_id: string; email: string; role: string; projects: { workspace_id: string; role: string; source: string; handle: string }[] }[];
};

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// A handle from an email's local part, the same rule the database uses for team grants.
export function handleFromEmail(email: string) {
  const base = email.split("@")[0].toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 28);
  return base.length >= 2 ? base : "user";
}

// The team to act on: --team, else the active project's team, else your only team.
export async function resolveTeam(sb: SupabaseClient, slug?: string): Promise<Team> {
  if (slug) {
    const t = check(await sb.from("teams").select("*").eq("slug", slug).maybeSingle<Team>());
    if (!t) throw new CliError(`No team "${slug}" that you belong to. See: contexter team list`);
    return t;
  }
  const active = loadConfig().activeWorkspace;
  if (active) {
    const ws = check(await sb.from("workspaces").select("team_id").eq("id", active.id).maybeSingle<{ team_id: string | null }>());
    if (ws?.team_id) return check(await sb.from("teams").select("*").eq("id", ws.team_id).single<Team>());
  }
  const all = check(await sb.from("teams").select("*").order("name")) as Team[];
  if (all.length === 1) return all[0];
  if (!all.length) throw new CliError("You're not on a team yet. Create one with: contexter team create <slug>");
  throw new CliError(`Pick a team with --team (yours: ${all.map((t) => t.slug).join(", ")})`);
}

async function overview(sb: SupabaseClient, team: Team): Promise<Overview> {
  return check(await sb.rpc("team_overview", { p_team: team.id })) as Overview;
}

async function userByEmail(sb: SupabaseClient, team: Team, email: string) {
  const ov = await overview(sb, team);
  const person = ov.roster.find((r) => r.email.toLowerCase() === email.toLowerCase());
  if (!person) throw new CliError(`${email} isn't on ${team.name}. See: contexter team show`);
  return { person, ov };
}

const pad = (s: string, n: number) => (s.length >= n ? `${s} ` : s.padEnd(n));

// ───────── invite by email ─────────
export async function inviteByEmail(emails: string[], opts: { team?: string; project?: string[]; role?: string; admin?: boolean }) {
  const sb = getClient();
  await requireUser(sb);
  const bad = emails.filter((e) => !EMAIL.test(e));
  if (bad.length) throw new CliError(`Not email addresses: ${bad.join(", ")}`);
  const team = await resolveTeam(sb, opts.team);

  // Projects to give access to: --project slugs, else the active project when it's in this team.
  let slugs = opts.project ?? [];
  if (!slugs.length) {
    const active = loadConfig().activeWorkspace;
    const ws = active && check(await sb.from("workspaces").select("slug, team_id").eq("id", active.id).maybeSingle<{ slug: string; team_id: string | null }>());
    if (ws && ws.team_id === team.id) slugs = [ws.slug];
  }
  const grants = [];
  for (const slug of slugs) {
    const ws = check(await sb.from("workspaces").select("id, team_id").eq("slug", slug).maybeSingle<{ id: string; team_id: string | null }>());
    if (!ws) throw new CliError(`No project "${slug}" that you can see`);
    if (ws.team_id !== team.id) throw new CliError(`"${slug}" isn't a project of ${team.name}`);
    grants.push({ workspace_id: ws.id, role: opts.role ?? "editor" });
  }

  const { data, error } = await sb.functions.invoke("invite-members", {
    body: { team: team.id, emails, team_role: opts.admin ? "admin" : "member", grants },
  });
  if (error) {
    const detail = await (error as { context?: Response }).context?.json?.().catch(() => null);
    throw new CliError(detail?.error ?? error.message);
  }
  const access = grants.length ? `${slugs.join(", ")} as ${opts.role ?? "editor"}` : "the team only";
  console.log(`Invited to ${team.name} (${access}):`);
  for (const i of (data as { invited: { email: string; mail: string; error?: string }[] }).invited) {
    console.log(`  ${pad(i.email, 32)} ${i.mail === "sent" ? "email sent" : `saved, email failed (${i.error}); they can still accept by signing in`}`);
  }
  console.log("\nThey join with: contexter login, then contexter join (or the link in the email).");
}

// ───────── join: accept pending invitations (no code needed) ─────────
export async function acceptInvites() {
  const sb = getClient();
  const user = await requireUser(sb);
  const accepted = check(await sb.rpc("accept_pending_invites")) as { team: string; name?: string; workspaces: string[] }[];
  if (!accepted.length) {
    console.log(`No pending invitations for ${user.email}.`);
    console.log("Ask a team admin to invite this address, or join with an invite code: contexter join <code>");
    return;
  }
  for (const a of accepted) {
    console.log(`Joined ${a.name ?? a.team}${a.workspaces.length ? ` with access to ${a.workspaces.join(", ")}` : " (no projects yet)"}.`);
  }
  const first = accepted.flatMap((a) => a.workspaces)[0];
  if (first) {
    const ws = check(await sb.from("workspaces").select("id, slug").eq("slug", first).single<{ id: string; slug: string }>());
    saveConfig({ activeWorkspace: ws });
    await core.setActiveWorkspace(sb, user.id, ws.id);
    console.log(`Active workspace: ${ws.slug}. Connect Claude with: contexter install code --workspace ${ws.slug}`);
  }
}

// ───────── team list / show / create / role / remove / invites / revoke / default ─────────
export async function listTeams() {
  const sb = getClient();
  const user = await requireUser(sb);
  const teams = check(await sb.from("teams").select("*").order("name")) as Team[];
  const roles = check(await sb.from("team_members").select("team_id, role").eq("user_id", user.id)) as { team_id: string; role: string }[];
  if (!teams.length) return console.log("You're not on a team yet. Create one with: contexter team create <slug>");
  for (const t of teams) console.log(`${pad(t.slug, 24)} ${pad(t.name, 28)} ${roles.find((r) => r.team_id === t.id)?.role ?? ""}`);
}

export async function showTeam(slug?: string) {
  const sb = getClient();
  const user = await requireUser(sb);
  const team = await resolveTeam(sb, slug);
  const mine = check(await sb.from("team_members").select("role").eq("team_id", team.id).eq("user_id", user.id).maybeSingle<{ role: string }>());
  console.log(`${team.name} (${team.slug}), you are ${mine?.role === "admin" ? "an admin" : `the ${mine?.role ?? "member"}`}`);
  if (mine?.role === "member") {
    const rows = check(await sb.from("members").select("role, workspaces(slug, team_id)").eq("user_id", user.id)) as any[];
    const yours = rows.filter((r) => r.workspaces?.team_id === team.id);
    console.log(`\nYour projects\n${yours.map((r) => `  ${pad(r.workspaces.slug, 24)} ${r.role}`).join("\n") || "  none yet"}`);
    console.log("\nOnly team admins can see everyone and change access.");
    return;
  }
  const ov = await overview(sb, team);
  const slugOf = new Map(ov.projects.map((p) => [p.id, p.slug]));
  console.log(`\nProjects`);
  for (const p of ov.projects) console.log(`  ${pad(p.slug, 24)} ${pad(p.template, 16)} ${p.members} ${p.members === 1 ? "person" : "people"}`);
  if (!ov.projects.length) console.log("  none yet. Create one: contexter init <slug> --team " + team.slug);
  console.log(`\nPeople`);
  for (const r of ov.roster) {
    const access = r.projects.map((x) => `${slugOf.get(x.workspace_id)}:${x.role}`).join(", ") || "no projects";
    console.log(`  ${pad(r.email + (r.user_id === user.id ? " (you)" : ""), 34)} ${pad(r.role, 8)} ${access}`);
  }
  const invites = check(await sb.from("email_invites").select("email, expires_at").eq("team_id", team.id).eq("status", "pending").order("created_at")) as any[];
  if (invites.length) {
    console.log(`\nWaiting to join`);
    for (const i of invites) console.log(`  ${pad(i.email, 34)} expires ${new Date(i.expires_at).toLocaleDateString()}`);
  }
  console.log(`\nNew members get: ${team.new_member_access === "all_projects" ? "every project, as editors" : "only the projects they're invited to"}`);
}

export async function createTeam(slug: string, name?: string) {
  const sb = getClient();
  await requireUser(sb);
  const t = check(await sb.rpc("create_team", { p_slug: slug, p_name: name ?? slug }).single<Team>());
  console.log(`Created team ${t.name} (${t.slug}). You're its owner.`);
  console.log(`Next: contexter init <project> --team ${t.slug}, then contexter invite teammate@company.com --team ${t.slug}`);
}

export async function setRole(email: string, role: string, opts: { team?: string }) {
  const sb = getClient();
  await requireUser(sb);
  const team = await resolveTeam(sb, opts.team);
  const { person } = await userByEmail(sb, team, email);
  check(await sb.rpc("set_team_member_role", { p_team: team.id, p_user: person.user_id, p_role: role }));
  console.log(`${person.email} is now ${role === "admin" ? "an admin" : `a${role === "owner" ? "n" : ""} ${role}`} of ${team.name}.`);
}

export async function removeMember(email: string, opts: { team?: string }) {
  const sb = getClient();
  const user = await requireUser(sb);
  const team = await resolveTeam(sb, opts.team);
  if (email.toLowerCase() === user.email?.toLowerCase()) {
    check(await sb.rpc("remove_team_member", { p_team: team.id, p_user: user.id }));
    return console.log(`You left ${team.name}. Projects the team gave you are gone; anything you joined directly stays.`);
  }
  const { person } = await userByEmail(sb, team, email);
  check(await sb.rpc("remove_team_member", { p_team: team.id, p_user: person.user_id }));
  console.log(`Removed ${person.email} from ${team.name}, with the project access the team gave them.`);
}

export async function listInvites(opts: { team?: string }) {
  const sb = getClient();
  await requireUser(sb);
  const team = await resolveTeam(sb, opts.team);
  const rows = check(await sb.from("email_invites").select("email, team_role, grants, expires_at").eq("team_id", team.id).eq("status", "pending").order("created_at")) as any[];
  if (!rows.length) return console.log(`Nobody is waiting to join ${team.name}.`);
  const projects = check(await sb.from("workspaces").select("id, slug").eq("team_id", team.id)) as { id: string; slug: string }[];
  const slugOf = new Map(projects.map((p) => [p.id, p.slug]));
  for (const r of rows) {
    const access = (r.grants ?? []).map((g: { workspace_id: string; role: string }) => `${slugOf.get(g.workspace_id) ?? "project"}:${g.role}`).join(", ") || "team only";
    console.log(`  ${pad(r.email, 34)} ${pad(r.team_role, 8)} ${pad(access, 28)} expires ${new Date(r.expires_at).toLocaleDateString()}`);
  }
}

export async function revokeInvite(email: string, opts: { team?: string }) {
  const sb = getClient();
  await requireUser(sb);
  const team = await resolveTeam(sb, opts.team);
  const inv = check(await sb.from("email_invites").select("id").eq("team_id", team.id).eq("status", "pending").eq("email", email.toLowerCase()).maybeSingle<{ id: string }>());
  if (!inv) throw new CliError(`No pending invitation for ${email} in ${team.name}`);
  check(await sb.rpc("revoke_invite", { p_invite: inv.id }));
  console.log(`Revoked the invitation to ${email}.`);
}

export async function setDefault(value: string, opts: { team?: string }) {
  const sb = getClient();
  await requireUser(sb);
  const team = await resolveTeam(sb, opts.team);
  const next = value === "all" ? "all_projects" : "none";
  check(await sb.from("teams").update({ new_member_access: next }).eq("id", team.id).select("id").single());
  console.log(next === "all_projects"
    ? `New members of ${team.name} now get every project as editors.`
    : `New members of ${team.name} now get only the projects they're invited to.`);
}

export async function transferOwnership(email: string, opts: { workspace?: string }) {
  const sb = getClient();
  await requireUser(sb);
  const slug = opts.workspace ?? loadConfig().activeWorkspace?.slug;
  if (!slug) throw new CliError("Which project? Pass --workspace <slug> or make one active with contexter use");
  const ws = check(await sb.from("workspaces").select("id, slug, team_id").eq("slug", slug).maybeSingle<{ id: string; slug: string; team_id: string | null }>());
  if (!ws) throw new CliError(`No project "${slug}" that you can see`);
  let uid: string | undefined;
  if (ws.team_id) {
    const team = check(await sb.from("teams").select("*").eq("id", ws.team_id).single<Team>());
    uid = (await userByEmail(sb, team, email)).person.user_id;
  } else {
    throw new CliError("Ownership transfer by email works for team projects. Add the project to a team first.");
  }
  check(await sb.rpc("transfer_project_ownership", { p_workspace: ws.id, p_user: uid }));
  console.log(`${email} now owns ${ws.slug}. You stay on it as an editor.`);
}
