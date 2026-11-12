// Claude Code hooks test: install contexter into two throwaway projects (alice, bob), then run
// the installed hook commands exactly as Claude Code does (stdin JSON, stdout JSON).
// Run: npm run build && npm run test:hooks (with `npm run db:start` up).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI, cliRunner } from "./lib/cli.ts";
import { signIn } from "./lib/local.ts";

const run = Date.now().toString(36);
const slug = `hooks-${run}`;
const root = mkdtempSync(join(tmpdir(), "contexter-hooks-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const { cli, login: cliLogin } = cliRunner(root);
const login = (who: string) => cliLogin(who, `${who}-${run}@hooks.local`);

// The hook commands as installed in the project's .claude/settings.json.
function installedHooks(who: string): Record<string, string> {
  const settings = JSON.parse(readFileSync(join(root, who, ".claude/settings.json"), "utf8"));
  return Object.fromEntries(Object.entries<any[]>(settings.hooks).map(([ev, groups]) => [ev, groups[0].hooks[0].command]));
}

function hook(who: string, event: string, input: Record<string, unknown>) {
  const started = Date.now();
  const r = spawnSync("sh", ["-c", installedHooks(who)[event]], {
    input: JSON.stringify({ hook_event_name: event, cwd: join(root, who), ...input }), encoding: "utf8",
    cwd: join(root, who), env: { ...process.env, CONTEXTER_HOME: join(root, who, ".home") },
  });
  const context = r.stdout ? JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? "" : "";
  return { status: r.status, context, ms: Date.now() - started, stderr: r.stderr };
}

function transcript(who: string, turns: { user: string; assistant: string; wrote?: string }[]) {
  const path = join(root, who, `transcript-${Math.random().toString(36).slice(2)}.jsonl`);
  const lines: unknown[] = [];
  for (const t of turns) {
    lines.push({ type: "user", message: { role: "user", content: t.user } });
    if (t.wrote) {
      lines.push({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: join(root, who, t.wrote), content: "x" } }] } });
      lines.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
    }
    lines.push({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: t.assistant }] } });
  }
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
  return path;
}

let passed = 0;
async function step(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log(`ok - ${name}`); } catch (err) { console.log(`not ok - ${name}`); throw err; }
}

await login("alice");
await login("bob");
cli("alice", ["init", slug, "--handle", "alice", "--template", "research-paper"]);
const code = /^ {2}(\S+)$/m.exec(cli("alice", ["invite"]))![1];
cli("bob", ["join", code, "--handle", "bob"]);

await step("install writes hooks, skill and project link", () => {
  for (const who of ["alice", "bob"]) {
    const out = cli(who, ["install", "code", "--workspace", slug]);
    assert.match(out, /claude mcp add --transport http .*x-contexter-client: claude-code.* contexter http/);
    assert.deepEqual(Object.keys(installedHooks(who)).sort(), ["SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"]);
    assert.ok(readFileSync(join(root, who, ".claude/skills/contexter/SKILL.md"), "utf8").includes("name: contexter"));
    assert.equal(JSON.parse(readFileSync(join(root, who, ".contexter.json"), "utf8")).workspace, slug);
  }
  // Re-installing replaces rather than duplicates.
  cli("alice", ["install", "code", "--workspace", slug]);
  const s = JSON.parse(readFileSync(join(root, "alice/.claude/settings.json"), "utf8"));
  assert.equal(s.hooks.Stop.length, 1);
});

await step("bob's session starts with the workspace overview", () => {
  const r = hook("bob", "SessionStart", { session_id: "bob-1", source: "startup" });
  assert.equal(r.status, 0);
  assert.match(r.context, new RegExp(`shared contexter workspace "${slug}"`));
  assert.match(r.context, /sections\/method · outline · v0/);
  assert.match(r.context, /shared memory/);
  console.log(`   (SessionStart took ${r.ms}ms)`);
});

await step("alice's turn is posted: prompt on submit, reply summary on stop", () => {
  hook("alice", "SessionStart", { session_id: "alice-1", source: "startup" });
  const p = hook("alice", "UserPromptSubmit", { session_id: "alice-1", prompt: "Draft the introduction, @bob please review it after" });
  assert.equal(p.status, 0);
  console.log(`   (UserPromptSubmit took ${p.ms}ms)`);
  const t = transcript("alice", [{ user: "Draft the introduction", assistant: "I drafted the introduction around dense retrieval. It sets up the three research questions.", wrote: "intro.md" }]);
  const s = hook("alice", "Stop", { session_id: "alice-1", transcript_path: t, stop_hook_active: false });
  assert.equal(s.status, 0);
});

await step("bob's next message knows what alice did, and that she mentioned him", () => {
  const r = hook("bob", "UserPromptSubmit", { session_id: "bob-1", prompt: "what should I do next?" });
  assert.match(r.context, /alice · .* · asked: "Draft the introduction, @bob please review it after"  ← mentions you/);
  assert.match(r.context, /alice · .* · → their Claude: I drafted the introduction around dense retrieval\. It sets up the three research questions\. \[files: intro\.md\]/);
});

await step("Stop prefers last_assistant_message when Claude Code provides it", () => {
  hook("alice", "UserPromptSubmit", { session_id: "alice-1", prompt: "Now the related work" });
  hook("alice", "Stop", { session_id: "alice-1", last_assistant_message: "Related work now compares six dense retrievers." });
  const r = hook("bob", "UserPromptSubmit", { session_id: "bob-1", prompt: "and now?" });
  assert.match(r.context, /→ their Claude: Related work now compares six dense retrievers\./);
});

await step("!private turns are not shared", () => {
  const p = hook("alice", "UserPromptSubmit", { session_id: "alice-1", prompt: "!private my secret plan for bob's section" });
  assert.match(p.context, /This message is private/);
  hook("alice", "Stop", { session_id: "alice-1", last_assistant_message: "Here is the secret plan." });
  const r = hook("bob", "UserPromptSubmit", { session_id: "bob-1", prompt: "anything new?" });
  assert.doesNotMatch(r.context, /secret/);
});

await step("same member, other client: alice's chat sees her own Code session", async () => {
  const a = await signIn(`alice-${run}@hooks.local`);
  const ws = (await a.sb.from("workspaces").select("id").eq("slug", slug).single()).data!;
  const chat = (await a.sb.rpc("ensure_session", { p_workspace: ws.id, p_client: "claude-chat" }).single()).data as { id: string };
  hook("alice", "UserPromptSubmit", { session_id: "alice-1", prompt: "Code-side question" });
  const { data } = await a.sb.rpc("pull_feed", { p_workspace: ws.id, p_limit: 100, p_session: chat.id });
  assert.ok((data as any[]).some((e) => e.payload?.text === "Code-side question"));
});

await step("compaction is requested once the feed outgrows the memory", async () => {
  const b = await signIn(`bob-${run}@hooks.local`);
  const ws = (await b.sb.from("workspaces").select("id").eq("slug", slug).single()).data!;
  await b.sb.from("events").insert(Array.from({ length: 45 }, (_, i) => ({
    workspace_id: ws.id, author_id: b.userId, kind: "prompt", payload: { text: `filler ${i}` },
  })));
  const r = hook("alice", "UserPromptSubmit", { session_id: "alice-1", prompt: "ok" });
  assert.match(r.context, /shared memory is \d+ events behind/);
  assert.match(r.context, /call compact_memory/);
  assert.match(r.context, /earlier events not shown|filler 44/);
});

await step("session end releases locks", async () => {
  const a = await signIn(`alice-${run}@hooks.local`);
  const state = JSON.parse(readFileSync(join(root, "alice/.home/sessions/alice-1.json"), "utf8"));
  const unit = (await a.sb.from("units").select("id").eq("key", "method").eq("workspace_id",
    (await a.sb.from("workspaces").select("id").eq("slug", slug).single()).data!.id).single()).data!;
  await a.sb.rpc("claim_unit", { p_unit: unit.id, p_session: state.session });
  assert.equal(hook("alice", "SessionEnd", { session_id: "alice-1", reason: "prompt_input_exit" }).status, 0);
  const after = (await a.sb.from("units").select("lock_holder").eq("id", unit.id).single()).data!;
  assert.equal(after.lock_holder, null);
});

await step("hooks never block Claude: signed out or unlinked projects stay silent with exit 0", () => {
  const empty = mkdtempSync(join(tmpdir(), "contexter-empty-"));
  const r = spawnSync("node", [CLI, "hook", "user-prompt-submit"], {
    input: JSON.stringify({ session_id: "x", prompt: "hi", cwd: empty }), encoding: "utf8",
    env: { ...process.env, CONTEXTER_HOME: join(empty, ".home") },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  rmSync(empty, { recursive: true, force: true });
});

await step("uninstall removes hooks and skill", () => {
  cli("bob", ["uninstall"]);
  const s = JSON.parse(readFileSync(join(root, "bob/.claude/settings.json"), "utf8"));
  assert.equal(s.hooks, undefined);
});

console.log(`\n${passed} hook checks passed`);
