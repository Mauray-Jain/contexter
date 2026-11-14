// Integration test for the invite-members Edge Function against the local stack: real mail
// lands in Mailpit, the invite link is followed, and the invite is applied on sign-in.
// Run: npm run test:invite (with `npm run db:start` up).
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { localEnv, signIn } from "./lib/local.ts";

const { url, key, functions } = localEnv();
const MAIL = "http://127.0.0.1:55324/api/v1";
const run = Date.now().toString(36);
const dom = "invite.local";

let passed = 0;
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.log(`not ok - ${name}`);
    throw err;
  }
}

const invite = (token: string | null, body: unknown) =>
  fetch(`${functions}/invite-members`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

async function mailTo(email: string, match: RegExp): Promise<{ Subject: string; Text: string; HTML: string }> {
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`${MAIL}/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
    for (const m of list.messages ?? []) {
      const msg = await (await fetch(`${MAIL}/message/${m.ID}`)).json();
      if (match.test(`${msg.Subject}\n${msg.Text}`)) return { Subject: msg.Subject, Text: msg.Text, HTML: msg.HTML };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no mail to ${email} matching ${match}`);
}

const aliceEmail = `alice-${run}@${dom}`, bobEmail = `bob-${run}@${dom}`;
const newbieEmail = `newbie-${run}@${dom}`, carolEmail = `carol-${run}@${dom}`;
const alice = await signIn(aliceEmail);
const bob = await signIn(bobEmail);         // already has an account
const carol = await signIn(carolEmail);     // has an account but is never invited

const team = (await alice.sb.rpc("create_team", { p_slug: `acme-${run}`, p_name: `Acme ${run}` }).single<{ id: string }>()).data!;
const ws = (await alice.sb.rpc("create_workspace", { p_slug: `paper-${run}`, p_name: "Paper", p_handle: "alice" })
  .single<{ id: string }>()).data!;
await alice.sb.rpc("attach_workspace_to_team", { p_workspace: ws.id, p_team: team.id });
const grants = [{ workspace_id: ws.id, role: "viewer" }];

await step("rejects callers who are not signed in", async () => {
  assert.equal((await invite(null, { team: team.id, emails: [newbieEmail] })).status, 401);
  assert.equal((await invite("not-a-token", { team: team.id, emails: [newbieEmail] })).status, 401);
});

await step("rejects malformed requests", async () => {
  assert.equal((await invite(alice.token, { team: "nope", emails: [newbieEmail] })).status, 400);
  assert.equal((await invite(alice.token, { team: team.id, emails: "x@y.co" })).status, 400);
  assert.equal((await invite(alice.token, { team: team.id, emails: [] })).status, 400);
  assert.equal((await invite(alice.token, { team: team.id, emails: ["not-an-email"] })).status, 400);
  assert.equal((await invite(alice.token, { team: team.id, emails: [newbieEmail], grants: [{ workspace_id: crypto.randomUUID(), role: "editor" }] })).status, 400);
});

await step("only team admins can invite", async () => {
  assert.equal((await invite(bob.token, { team: team.id, emails: [newbieEmail] })).status, 403);
  assert.equal((await invite(carol.token, { team: team.id, emails: [newbieEmail] })).status, 403);
  const { count } = await alice.sb.from("email_invites").select("*", { count: "exact", head: true });
  assert.equal(count, 0, "refused requests must not leave invites behind");
});

let inviteLink = "";
await step("emails a new person and an existing one, and records both invites", async () => {
  const res = await invite(alice.token, { team: team.id, emails: [newbieEmail.toUpperCase(), bobEmail], grants });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json() as { invited: { email: string; mail: string }[] };
  assert.deepEqual(body.invited.map((i) => [i.email, i.mail]).sort(), [[bobEmail, "sent"], [newbieEmail, "sent"]]);
  const { data } = await alice.sb.from("email_invites").select("email,status").eq("team_id", team.id);
  assert.deepEqual((data ?? []).map((r) => r.email).sort(), [bobEmail, newbieEmail]);
});

await step("the new person's email names the team and who invited them", async () => {
  const mail = await mailTo(newbieEmail, /invited/i);
  assert.match(mail.Subject, /invited/i);
  assert.ok(mail.HTML.includes(`Acme ${run}`) || mail.Text.includes(`Acme ${run}`), "team name in the email");
  assert.ok(mail.HTML.includes(aliceEmail) || mail.Text.includes(aliceEmail), "inviter in the email");
  inviteLink = /https?:\/\/[^\s"'<>]+verify[^\s"'<>]+/.exec(mail.HTML.replace(/&amp;/g, "&"))?.[0] ?? "";
  assert.ok(inviteLink, "an accept link");
});

await step("following the link signs them in with a verified email, and the invite applies", async () => {
  const hop = await fetch(inviteLink, { redirect: "manual" });
  const loc = hop.headers.get("location") ?? "";
  assert.match(loc, /\/join/, `lands on the join page: ${loc}`);
  const token = new URLSearchParams(new URL(loc).hash.slice(1)).get("access_token");
  assert.ok(token, "a session in the redirect");
  const sb = createClient(url, key, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
  const { data, error } = await sb.rpc("accept_pending_invites");
  assert.equal(error, null);
  assert.deepEqual(data, [{ team: `acme-${run}`, name: `Acme ${run}`, workspaces: [`paper-${run}`] }]);
  const { data: mine } = await sb.from("members").select("role,source").eq("workspace_id", ws.id).eq("source", "team");
  assert.deepEqual(mine, [{ role: "viewer", source: "team" }], "granted as a team viewer");
});

await step("an existing account gets a sign-in email that leads to the join page", async () => {
  const mail = await mailTo(bobEmail, /pending team invitation/i);
  assert.match(mail.HTML.replace(/&amp;/g, "&"), /redirect_to=[^"&]*%2Fjoin|redirect_to=[^"&]*\/join/);
  const { data } = await bob.sb.rpc("accept_pending_invites");
  assert.equal(data?.[0]?.team, `acme-${run}`);
});

await step("someone who was not invited gets nothing", async () => {
  const { data } = await carol.sb.rpc("accept_pending_invites");
  assert.deepEqual(data, []);
  const { data: seen } = await carol.sb.from("workspaces").select("id");
  assert.deepEqual(seen, []);
});

await step("re-inviting is allowed and does not duplicate the invite", async () => {
  const res = await invite(alice.token, { team: team.id, emails: [carolEmail] });
  assert.equal(res.status, 200);
  assert.equal((await invite(alice.token, { team: team.id, emails: [carolEmail] })).status, 200);
  const { data } = await alice.sb.from("email_invites").select("id").eq("team_id", team.id).eq("email", carolEmail).eq("status", "pending");
  assert.equal(data?.length, 1);
});

console.log(`\n${passed} invite checks passed`);
process.exit(0);
