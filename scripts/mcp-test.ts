// Integration test for the remote MCP server: two members talk to the local Edge Function
// through a real MCP client. Run: npm run test:mcp (with `npm run db:start` up).
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { localEnv, signIn } from "./lib/local.ts";

const { functions } = localEnv();
const run = Date.now().toString(36);
const slug = `mcp-${run}`;

async function mcpAs(token: string) {
  const client = new Client({ name: "contexter-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${functions}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: { workspace: slug, ...args } });
    const text = (res.content as { text: string }[]).map((c) => c.text).join("\n\n");
    return { text, isError: Boolean(res.isError) };
  };
  return { client, call };
}

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

const alice = await signIn(`alice-${run}@mcp.local`);
const bob = await signIn(`bob-${run}@mcp.local`);

// Workspace setup through the database directly (the CLI covers this path in e2e-local.sh).
const ws = (await alice.sb.rpc("create_workspace", {
  p_slug: slug, p_name: "MCP test paper", p_handle: "alice", p_template: "research-paper",
  p_manifest: { collections: { sections: { statuses: ["outline", "drafting", "review", "final"] } }, rules: ["Cite with [@key]"] },
}).single()).data as { id: string };
await alice.sb.from("units").insert([
  { workspace_id: ws.id, collection: "sections", key: "method", position: 1 },
  { workspace_id: ws.id, collection: "sections", key: "results", position: 2 },
]);
const invite = (await alice.sb.from("invites").insert({ workspace_id: ws.id }).select("code").single()).data!;
assert.equal((await bob.sb.rpc("join_workspace", { p_code: invite.code, p_handle: "bob" })).error, null);

const A = await mcpAs(alice.token);
const B = await mcpAs(bob.token);
// Clear the join events from both feeds so later assertions see only this test's activity.
await A.call("sync");
await B.call("sync");

await step("server lists tools, prompts and resources", async () => {
  const tools = (await A.client.listTools()).tools.map((t) => t.name);
  for (const t of ["sync", "resume", "post_turn", "read_unit", "write_unit", "record", "why", "search", "mention", "compact_memory",
    "start_run", "update_run", "runs", "watch_run", "handoff", "resolve_handoff"]) {
    assert.ok(tools.includes(t), `missing tool ${t}`);
  }
  const prompts = (await A.client.listPrompts()).prompts.map((p) => p.name);
  assert.deepEqual(prompts.sort(), ["checkpoint", "onboard", "resume", "review"]);
  const templates = (await A.client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
  assert.ok(templates.includes("contexter://unit/{collection}/{key}"));
});

await step("unauthenticated requests are refused with an OAuth challenge", async () => {
  const res = await fetch(`${functions}/mcp`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata=/);
});

await step("overview shows units and rules", async () => {
  const r = await A.call("get_overview");
  assert.match(r.text, /sections\/method · outline · v0/);
  assert.match(r.text, /Cite with \[@key\]/);
});

await step("write with reasoning creates v1 and a rationale record", async () => {
  const r = await A.call("write_unit", {
    ref: "sections/method", content: "# Method\n\nWe use dense retrieval.", expected_version: 0,
    summary: "First draft of method", reasoning: "Dense beats BM25 on our pilot (F-0001).",
  });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Saved sections\/method v1 \(reasoning R-0001\)/);
});

await step("teammate's sync shows the edit, attributed", async () => {
  const r = await B.call("sync");
  assert.match(r.text, /alice · .* · edited sections\/method \(v0→v1\): First draft of method/);
});

await step("stale write is refused with merge guidance", async () => {
  const r = await B.call("write_unit", { ref: "sections/method", content: "x", expected_version: 0, summary: "stale" });
  assert.equal(r.isError, true);
  assert.match(r.text, /changed since v0; it's now v1/);
});

await step("locks block other members", async () => {
  assert.equal((await A.call("claim_unit", { ref: "sections/method" })).isError, false);
  const r = await B.call("write_unit", { ref: "sections/method", content: "x", expected_version: 1, summary: "while locked" });
  assert.equal(r.isError, true);
  assert.match(r.text, /locked/);
  assert.match((await B.call("sync")).text, /alice holds the lock on sections\/method/);
  await A.call("release_unit", { ref: "sections/method" });
});

await step("mentions are raised first for the recipient", async () => {
  await B.call("mention", { to: ["alice"], text: "Can you check Table 2?" });
  const r = await A.call("sync");
  assert.match(r.text, /bob · .* · to @alice: "Can you check Table 2\?"  ← mentions you/);
});

await step("records and why", async () => {
  const d = await A.call("record", {
    type: "decision", title: "Drop the BM25 baseline", body: "Redundant with dense-only ablation.", links: ["sections/method"],
  });
  assert.match(d.text, /Recorded D-0001/);
  const w = await B.call("why", { target: "sections/method" });
  assert.match(w.text, /R-0001 rationale/);
  assert.match(w.text, /D-0001 decision .* Drop the BM25 baseline/);
  assert.match(w.text, /v1 · alice/);
});

await step("status changes are announced", async () => {
  assert.match((await A.call("set_status", { ref: "sections/method", status: "review" })).text, /outline → review/);
  assert.match((await B.call("sync")).text, /moved sections\/method outline → review/);
  assert.equal((await A.call("set_status", { ref: "sections/method", status: "bogus" })).isError, true);
});

await step("post_turn reaches teammates as one conversation", async () => {
  await A.call("post_turn", { user_request: "Tighten the method section", summary: "Rewrote the method intro around dense retrieval." });
  const r = await B.call("sync");
  assert.match(r.text, /alice · .* · asked: "Tighten the method section"/);
  assert.match(r.text, /alice · .* · → their Claude: Rewrote the method intro/);
});

await step("chat: sync with user_request shows the task live and warns about duplicates", async () => {
  await A.call("sync", { user_request: "Add an ablation table comparing reranker depth on MS MARCO" });
  const b = await B.call("sync", { user_request: "make an ablation table comparing the reranker depth" });
  assert.match(b.text, /── possible duplicate work ──/);
  assert.match(b.text, /alice · .* · asked "Add an ablation table comparing reranker depth on MS MARCO" \(still working on it\)/);
  assert.match(b.text, /alice is working on "Add an ablation table comparing reranker depth on MS MARCO"/);
  await A.call("post_turn", { user_request: "Add an ablation table comparing reranker depth on MS MARCO", summary: "Added Table 3: reranker depth ablation." });
  assert.doesNotMatch((await B.call("sync")).text, /alice is working on/, "post_turn finishes the task");
  await A.call("sync", { user_request: "Rename the reranker variables in the method section" });
  await A.call("sync"); // a !private turn: no user_request
  const after = (await B.call("sync")).text;
  assert.match(after, /alice is working on something private/);
  assert.doesNotMatch(after, /Rename the reranker/, "the previous task doesn't stay live during a private turn");
});

await step("search, history and diff", async () => {
  await A.call("write_unit", { ref: "sections/method", content: "# Method\n\nWe use dense retrieval with re-ranking.", expected_version: 1, summary: "Add re-ranking" });
  assert.match((await B.call("search", { query: "re-ranking" })).text, /\[unit\] sections\/method/);
  assert.match((await B.call("unit_history", { ref: "sections/method" })).text, /v2 · alice .* Add re-ranking/);
  const diff = (await B.call("diff_unit", { ref: "sections/method", from: 1 })).text;
  assert.match(diff, /- We use dense retrieval\.\n\+ We use dense retrieval with re-ranking\./);
});

await step("shared memory: compact, then resume shows it", async () => {
  const m = await A.call("compact_memory", { summary: "Alice drafted the method (dense retrieval + re-ranking); BM25 baseline dropped (D-0001).", covers_up_to: 999999 });
  assert.match(m.text, /Shared memory is now v1/);
  const r = await B.call("resume");
  assert.match(r.text, /shared memory v1/);
  assert.match(r.text, /BM25 baseline dropped/);
});

await step("prompts and resources", async () => {
  const p = await A.client.getPrompt({ name: "review", arguments: { ref: "sections/method" } });
  assert.match((p.messages[0].content as { text: string }).text, /read_unit sections\/method/);
  await A.call("use_workspace", { workspace: slug });
  const res = await A.client.readResource({ uri: "contexter://unit/sections/method" });
  assert.match((res.contents[0] as { text: string }).text, /re-ranking/);
});

await step("feed is empty when nothing new happened", async () => {
  await B.call("sync");
  assert.match((await B.call("sync")).text, /No new activity/);
});

await step("runs: everyone sees a run live, and its end reaches its watchers", async () => {
  assert.match((await A.call("start_run", { title: "stress test", host: "watermax", watchers: ["bob"] })).text, /Registered run #1\b/);
  let b = (await B.call("sync")).text;
  assert.match(b, /alice · just now · started run #1 "stress test" on watermax \(watching: @bob\)  ← mentions you/);
  assert.match(b, /── runs .*──\n• run #1 · alice · "stress test" on watermax · running \d+s · last checked just now \(you're watching\)/);
  await A.call("update_run", { run: 1, progress: "step 1200/5000" });
  assert.match((await B.call("sync")).text, /run #1 · alice .* running .* · step 1200\/5000/);
  await A.call("update_run", { run: 1, status: "failed", exit_code: 137, progress: "Killed", log_tail: "step 1300/5000\nKilled" });
  b = (await B.call("sync")).text;
  assert.match(b, /run #1 "stress test" on watermax failed \(exit 137\) after \d+s; last: "Killed"  ← mentions you/);
  assert.match(b, /run #1 · alice · "stress test" on watermax · FAILED \(exit 137\) just now · last: "Killed" \(you're watching\)/);
  const detail = (await B.call("runs", { run: 1 })).text;
  assert.match(detail, /watching: bob/);
  assert.match(detail, /log tail ──────\nstep 1300\/5000\nKilled/);
});

await step("handoff: alice's unfinished work goes to bob's Claude, with her locks and runs", async () => {
  await A.call("claim_unit", { ref: "sections/results" });
  await A.call("start_run", { title: "training", host: "watermax" });
  const h = await A.call("handoff", {
    to: "bob", title: "Finish the results section",
    summary: "Training (run #2) is going; results section has the table but no discussion yet.",
    next_steps: "1. Wait for run #2. 2. Add the numbers to the table. 3. Write the discussion.",
    files: ["sections/results"],
  });
  assert.match(h.text, /Handoff #1 is waiting for @bob.*They now watch your running #2/s);
  let b = (await B.call("sync")).text;
  assert.match(b, /^── handed to you ──\nhandoff #1 from alice · just now · "Finish the results section"/);
  assert.match(b, /Next steps: 1\. Wait for run #2/);
  assert.match(b, /run #2 · alice · "training" on watermax · running .*\(you're watching\)/);
  assert.match((await B.call("resolve_handoff", { handoff: 1, action: "accept" })).text, /You took over handoff #1/);
  assert.match((await B.call("read_unit", { ref: "sections/results" })).text, /locked by bob/);
  assert.match((await A.call("sync")).text, /bob · just now · took over handoff #1 "Finish the results section"  ← mentions you/);
  b = (await B.call("sync")).text;
  assert.doesNotMatch(b, /handed to you/, "an accepted handoff isn't offered again");
  assert.equal((await B.call("resolve_handoff", { handoff: 1, action: "decline" })).isError, true);
  await B.call("release_unit", { ref: "sections/results" });
  await A.call("update_run", { run: 2, status: "cancelled" });
  await A.call("sync");
  await B.call("sync");
});

await step("outsiders can't reach the workspace", async () => {
  const eve = await signIn(`eve-${run}@mcp.local`);
  const E = await mcpAs(eve.token);
  const r = await E.call("read_unit", { ref: "sections/method" });
  assert.equal(r.isError, true);
  assert.match(r.text, /No workspace/);
});

console.log(`\n${passed} MCP checks passed`);
process.exit(0);
