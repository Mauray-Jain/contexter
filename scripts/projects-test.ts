// Team projects against the local stack: every template the CLI ships can be created from the web's
// path (create_team_project) and produces exactly the CLI's units and manifest, so the two never drift.
// Run: npm run test:projects (with `npm run db:start` up).
import assert from "node:assert/strict";
import { templates } from "../packages/cli/src/templates.ts";
import { signIn } from "./lib/local.ts";

const run = Date.now().toString(36);
let passed = 0;
async function step(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (err) { console.log(`not ok - ${name}`); throw err; }
}

const admin = await signIn(`admin-${run}@projects.local`);
const { data: team, error } = await admin.sb.rpc("create_team", { p_slug: `t-${run}`, p_name: `Team ${run}` }).single<{ id: string }>();
assert.equal(error, null);

await step("the database offers exactly the CLI's templates", async () => {
  const { data } = await admin.sb.from("templates").select("name").order("position");
  assert.deepEqual((data ?? []).map((t) => t.name), Object.keys(templates));
});

for (const [name, tpl] of Object.entries(templates)) {
  await step(`template ${name}: units and manifest match the CLI`, async () => {
    const slug = `${name}-${run}`.slice(0, 48);
    const { data: ws, error: e } = await admin.sb.rpc("create_team_project", { p_team: team!.id, p_slug: slug, p_name: name, p_template: name })
      .single<{ id: string; manifest: unknown; template: string }>();
    assert.equal(e, null, e?.message);
    assert.equal(ws!.template, name);
    assert.deepEqual(ws!.manifest, tpl.manifest);
    const { data: units } = await admin.sb.from("units").select("collection,key,status,position").eq("workspace_id", ws!.id);
    const norm = (u: { collection: string; key: string; status?: string | null; position?: number | null }) =>
      `${u.collection}/${u.key}:${u.status ?? "outline"}:${u.position ?? ""}`;
    assert.deepEqual((units ?? []).map(norm).sort(), tpl.units.map(norm).sort());
  });
}

await step("ownership moves to a teammate and the feed records it", async () => {
  const mate = await signIn(`mate-${run}@projects.local`);
  await admin.sb.rpc("invite_to_team", { p_team: team!.id, p_emails: [`mate-${run}@projects.local`] });
  await mate.sb.rpc("accept_pending_invites");
  const { data: ws } = await admin.sb.from("workspaces").select("id").eq("slug", `blank-${run}`).single<{ id: string }>();
  const { error: e } = await admin.sb.rpc("transfer_project_ownership", { p_workspace: ws!.id, p_user: mate.userId });
  assert.equal(e, null, e?.message);
  const { data: roles } = await mate.sb.from("members").select("user_id,role").eq("workspace_id", ws!.id);
  assert.equal(roles?.find((r) => r.user_id === mate.userId)?.role, "owner");
  assert.equal(roles?.find((r) => r.user_id === admin.userId)?.role, "editor");
  const { data: ev } = await mate.sb.from("events").select("payload").eq("workspace_id", ws!.id).eq("kind", "member").order("id", { ascending: false }).limit(1);
  assert.equal(ev?.[0]?.payload?.action, "became owner");
});

console.log(`\n${passed} project checks passed`);
process.exit(0);
