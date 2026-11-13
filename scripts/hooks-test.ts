// Claude Code hooks test: install contexter into two throwaway projects (alice, bob), then run
// the installed hook commands exactly as Claude Code does (stdin JSON, stdout JSON).
// Run: npm run build && npm run test:hooks (with `npm run db:start` up).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI, cliRunner } from "./lib/cli.ts";
import { signIn } from "./lib/local.ts";
import { projectPath } from "../packages/cli/src/hooks.ts";
import * as core from "../supabase/functions/_shared/contexter.ts";

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
  const output = r.stdout ? JSON.parse(r.stdout).hookSpecificOutput ?? {} : {};
  return { status: r.status, context: output.additionalContext ?? "", output, ms: Date.now() - started, stderr: r.stderr };
}

// The same, without waiting: to run several hooks at once, as Claude Code can.
function hookAsync(who: string, event: string, input: Record<string, unknown>): Promise<{ context: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn("sh", ["-c", installedHooks(who)[event]], {
      cwd: join(root, who), env: { ...process.env, CONTEXTER_HOME: join(root, who, ".home") },
    });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("error", reject);
    p.on("close", () => resolve({ context: out ? JSON.parse(out).hookSpecificOutput?.additionalContext ?? "" : "" }));
    p.stdin.end(JSON.stringify({ hook_event_name: event, cwd: join(root, who), ...input }));
  });
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
    assert.match(out, /claude mcp add --transport http .* contexter http\S+ --header "x-contexter-client: claude-code"/);
    assert.deepEqual(Object.keys(installedHooks(who)).sort(),
      ["PostToolUse", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"]);
    const settings = JSON.parse(readFileSync(join(root, who, ".claude/settings.json"), "utf8"));
    assert.equal(settings.hooks.PreToolUse[0].matcher, "Edit|Write|MultiEdit|NotebookEdit");
    assert.equal(settings.hooks.PostToolUse[0].matcher, "Edit|Write|MultiEdit|NotebookEdit|Bash");
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

// An approved edit: PreToolUse (checks), the tool runs, PostToolUse (records). Returns the check.
const editInput = (who: string, session: string, file: string) =>
  ({ session_id: session, tool_name: "Edit", tool_input: { file_path: join(root, who, file), old_string: "a", new_string: "b" } });
const tryEdit = (who: string, session: string, file: string) => hook(who, "PreToolUse", editInput(who, session, file));
const edit = (who: string, session: string, file: string) => {
  const pre = tryEdit(who, session, file);
  hook(who, "PostToolUse", { ...editInput(who, session, file), tool_response: { success: true } });
  return pre;
};

await step("teammates see what alice is working on right now", () => {
  hook("alice", "UserPromptSubmit", { session_id: "alice-1", prompt: "Add retry logic to the MCP client when Supabase returns 503" });
  const r = hook("bob", "UserPromptSubmit", { session_id: "bob-1", prompt: "anything going on?" });
  assert.match(r.context, /── in progress right now/);
  assert.match(r.context, /alice is working on "Add retry logic to the MCP client when Supabase returns 503" \(started just now, claude-code\)/);
});

await step("a request that repeats a teammate's work gets a duplicate warning", () => {
  const r = hook("bob", "UserPromptSubmit", { session_id: "bob-1", prompt: "add retry logic for 503 responses in the MCP client" });
  assert.match(r.context, /── possible duplicate work ──/);
  assert.match(r.context, /alice · just now · asked "Add retry logic to the MCP client when Supabase returns 503" \(still working on it\)/);
  assert.ok(r.context.indexOf("possible duplicate work") < r.context.indexOf("in progress right now"), "warning comes first");
});

await step("an unrelated request gets no duplicate warning", () => {
  const r = hook("bob", "UserPromptSubmit", { session_id: "bob-1", prompt: "write the conclusion about future datasets and limitations" });
  assert.doesNotMatch(r.context, /possible duplicate work/);
});

await step("editing a file a teammate is editing right now asks the user first, once", () => {
  assert.equal(edit("alice", "alice-1", "src/client.ts").context, "", "nobody else is on it yet");
  const r = edit("bob", "bob-1", "src/client.ts");
  assert.equal(r.status, 0);
  assert.equal(r.output.permissionDecision, "ask");
  assert.match(r.output.permissionDecisionReason, /alice is editing src\/client\.ts right now/);
  assert.match(r.context, /alice's Claude is editing src\/client\.ts right now, for "Add retry logic/);
  assert.match(r.context, /git status/);
  assert.deepEqual(edit("bob", "bob-1", "src/client.ts").output, {}, "warned once per file per session");
  const other = hook("bob", "UserPromptSubmit", { session_id: "bob-1", prompt: "status?" });
  assert.match(other.context, /alice is working on "Add retry logic.*files: src\/client\.ts/);
});

await step("after alice finishes, a recent change is a warning without a prompt", () => {
  const t = transcript("alice", [{ user: "Add retry logic", assistant: "Added retries with backoff to the MCP client for 503s.", wrote: "src/client.ts" }]);
  hook("alice", "Stop", { session_id: "alice-1", transcript_path: t, stop_hook_active: false });
  hook("bob", "SessionStart", { session_id: "bob-2", source: "startup" });
  const r = edit("bob", "bob-2", "src/client.ts");
  assert.equal(r.output.permissionDecision, undefined);
  assert.match(r.context, /alice's Claude changed src\/client\.ts just now: Added retries with backoff/);
  // bob-1 hasn't read alice's reply yet (bob-2 started with the backlog marked read).
  const p = hook("bob", "UserPromptSubmit", { session_id: "bob-1", prompt: "what's new?" });
  assert.doesNotMatch(p.context, /alice is working on/);
  assert.match(p.context, /Added retries with backoff to the MCP client for 503s\. \[files: src\/client\.ts\]/,
    "reply files are relative to the project root");
});

await step("private turns don't publish the files they edit", () => {
  hook("alice", "SessionStart", { session_id: "alice-p", source: "startup" });
  hook("alice", "UserPromptSubmit", { session_id: "alice-p", prompt: "!private rework my notes" });
  edit("alice", "alice-p", "private/notes.md");
  assert.equal(edit("bob", "bob-2", "private/notes.md").context, "", "bob isn't told about alice's private file");
  const r = hook("bob", "UserPromptSubmit", { session_id: "bob-2", prompt: "what is everyone doing?" });
  assert.match(r.context, /alice is working on something private/);
  assert.doesNotMatch(r.context, /notes\.md/);
  hook("alice", "Stop", { session_id: "alice-p", last_assistant_message: "Done." });
});

await step("project paths: names starting with .. are inside, parent paths are not", () => {
  const proj = join(root, "alice");
  assert.equal(projectPath(join(proj, "..notes/todo.md"), proj), "..notes/todo.md");
  assert.equal(projectPath(join(proj, "src/a.ts"), proj), "src/a.ts");
  assert.equal(projectPath(join(root, "bob/src/a.ts"), proj), undefined);
  assert.equal(projectPath(proj, proj), undefined);
});

await step("a rejected edit doesn't claim the file", () => {
  hook("alice", "SessionStart", { session_id: "alice-r", source: "startup" });
  hook("alice", "UserPromptSubmit", { session_id: "alice-r", prompt: "Tidy the evaluation scripts" });
  tryEdit("alice", "alice-r", "eval/run.py"); // the user said no: PostToolUse never fires
  assert.equal(tryEdit("bob", "bob-2", "eval/run.py").context, "", "bob isn't told alice is on a file she never edited");
  const r = hook("bob", "UserPromptSubmit", { session_id: "bob-2", prompt: "and alice?" });
  assert.match(r.context, /alice is working on "Tidy the evaluation scripts"/);
  assert.doesNotMatch(r.context, /eval\/run\.py/);
});

await step("a file warned about as a recent change still asks once a teammate starts editing it", () => {
  edit("alice", "alice-r", "docs/guide.md");
  const tr = transcript("alice", [{ user: "Tidy the guide", assistant: "Rewrote the guide intro.", wrote: "docs/guide.md" }]);
  hook("alice", "Stop", { session_id: "alice-r", transcript_path: tr, stop_hook_active: false });
  hook("bob", "SessionStart", { session_id: "bob-3", source: "startup" });
  const first = edit("bob", "bob-3", "docs/guide.md");
  assert.match(first.context, /alice's Claude changed docs\/guide\.md/);
  assert.equal(first.output.permissionDecision, undefined);
  hook("alice", "UserPromptSubmit", { session_id: "alice-r", prompt: "Add a troubleshooting section to the guide" });
  edit("alice", "alice-r", "docs/guide.md");
  const second = tryEdit("bob", "bob-3", "docs/guide.md");
  assert.equal(second.output.permissionDecision, "ask", "a live conflict asks even after the earlier warning");
  assert.match(second.context, /alice's Claude is editing docs\/guide\.md right now/);
  // bob says no: the edit never runs, so the next attempt asks again.
  assert.equal(tryEdit("bob", "bob-3", "docs/guide.md").output.permissionDecision, "ask", "a rejected edit asks again");
  // bob says yes this time: the edit runs, and he isn't asked again about this conflict.
  assert.equal(edit("bob", "bob-3", "docs/guide.md").output.permissionDecision, "ask");
  assert.deepEqual(tryEdit("bob", "bob-3", "docs/guide.md").output, {}, "an approved conflict isn't asked again");
  hook("alice", "Stop", { session_id: "alice-r", last_assistant_message: "Added troubleshooting." });
});

await step("files outside the project are ignored", () => {
  const r = hook("bob", "PreToolUse", { session_id: "bob-2", tool_name: "Write", tool_input: { file_path: "/etc/hosts", content: "x" } });
  assert.equal(r.status, 0);
  assert.deepEqual(r.output, {});
});

let bgRun = 0;
await step("a background command Claude starts becomes a run the team sees", () => {
  hook("alice", "UserPromptSubmit", { session_id: "alice-bg", prompt: "Start the stress test on the ingest service" });
  const r = hook("alice", "PostToolUse", { session_id: "alice-bg", tool_name: "Bash", tool_input: {
    command: "./stress.sh --rps 500", description: "Stress test the ingest service", run_in_background: true } });
  bgRun = Number(/now run #(\d+)/.exec(r.context)?.[1]);
  assert.ok(bgRun, r.context);
  assert.match(r.context, new RegExp(`call contexter's update_run with run=${bgRun}`));
  const b = hook("bob", "UserPromptSubmit", { session_id: "bob-1", prompt: "anything running?" });
  assert.match(b.context, new RegExp(`alice · just now · started run #${bgRun} "Stress test the ingest service" on \\S+`));
  assert.match(b.context, new RegExp(`── runs .*──\\n• run #${bgRun} · alice · "Stress test the ingest service" on \\S+ · running`));
  // Not runs: foreground commands, commands that report themselves through contexter run, private turns.
  for (const tool_input of [
    { command: "ls -la" },
    { command: "node /x/contexter.mjs run -t soak -- ./soak.sh", run_in_background: true },
  ]) {
    assert.equal(hook("alice", "PostToolUse", { session_id: "alice-bg", tool_name: "Bash", tool_input }).context, "");
  }
  hook("alice", "UserPromptSubmit", { session_id: "alice-bg", prompt: "!private start my side project's build" });
  assert.equal(hook("alice", "PostToolUse", { session_id: "alice-bg", tool_name: "Bash",
    tool_input: { command: "./side-project.sh", run_in_background: true } }).context, "");
  hook("alice", "Stop", { session_id: "alice-bg", last_assistant_message: "Started it." });
});

await step("a background command's run closes itself when Claude Code says the command ended", async () => {
  const out = join(root, "alice", "bg-task.output");
  writeFileSync(out, "warming up\nrps 500 ok\np99 41ms\n\n[exited with code 3]\n");
  const notify = (taskId: string, toolUseId: string, status: string, summary: string) => hook("alice", "UserPromptSubmit", {
    session_id: "alice-bg2", prompt: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n` +
      `<output-file>${out}</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`,
  });
  hook("alice", "UserPromptSubmit", { session_id: "alice-bg2", prompt: "Run the soak test" });
  const start = (toolUseId: string, taskId: string, command: string) => {
    const r = hook("alice", "PostToolUse", { session_id: "alice-bg2", tool_name: "Bash", tool_use_id: toolUseId,
      tool_input: { command, description: command, run_in_background: true }, tool_response: { backgroundTaskId: taskId } });
    assert.match(r.context, /Its end is reported automatically/);
    return Number(/now run #(\d+)/.exec(r.context)?.[1]);
  };
  const failing = start("toolu_a", "task_a", "./soak.sh");
  const ok = start("toolu_b", "task_b", "./bench.sh");
  // Matched by the tool call's id; the exit code comes from the summary, the progress from the output.
  const r = notify("other", "toolu_a", "failed", 'Background command "./soak.sh" failed with exit code 3');
  assert.match(r.context, new RegExp(`Run #${failing} ended \\(failed, exit 3\\)`));
  assert.match(r.context, new RegExp(`run #${failing} · you · "./soak.sh" on \\S+ · FAILED \\(exit 3\\) just now · last: "p99 41ms"`));
  // Matched by the task's id alone too.
  assert.match(notify("task_b", "toolu_other", "completed", "completed (exit code 0)").context,
    new RegExp(`Run #${ok} ended \\(succeeded, exit 0\\)`));
  // A second notification for a run that's already closed changes nothing.
  assert.doesNotMatch(notify("task_b", "toolu_b", "failed", "failed with exit code 9").context, /ended \(/);
  // A run Claude already reported is left alone.
  const reported = start("toolu_c", "task_c", "./load.sh");
  const a = await signIn(`alice-${run}@hooks.local`);
  const ctx = await core.loadCtx(a.sb, a.userId, { workspace: slug, session: null });
  await core.updateRun(ctx, (await core.getRun(ctx, reported)).id, { status: "cancelled", progress: "stopped by hand" });
  assert.doesNotMatch(notify("task_c", "toolu_c", "completed", "completed (exit code 0)").context, /ended \(/);
  const row = await core.getRun(ctx, reported);
  assert.equal(row.status, "cancelled");
  assert.equal(row.progress, "stopped by hand");
  // Two background commands registered at the same moment both close; a huge output is read from its end.
  const [x, y] = await Promise.all(["x", "y"].map((k) => hookAsync("alice", "PostToolUse", {
    session_id: "alice-bg2", tool_name: "Bash", tool_use_id: `toolu_${k}`, tool_response: { backgroundTaskId: `task_${k}` },
    tool_input: { command: `./job-${k}.sh`, run_in_background: true },
  })));
  const [runX, runY] = [x, y].map((r) => Number(/now run #(\d+)/.exec(r.context)?.[1]));
  const bg = join(root, "alice", ".home", "sessions", "alice-bg2.bg");
  assert.deepEqual(readdirSync(bg).sort(), ["task_x.json", "task_y.json", "toolu_x.json", "toolu_y.json"]);
  writeFileSync(out, `${"noise ".repeat(2_000_000)}\nlast line of a big log\n\n[exited with code 0]\n`);
  assert.match(notify("task_x", "toolu_x", "completed", "completed (exit code 0)").context, new RegExp(`Run #${runX} ended`));
  assert.equal((await core.getRun(ctx, runX)).progress, "last line of a big log");
  assert.match(notify("task_y", "toolu_y", "killed", "stopped").context, new RegExp(`Run #${runY} ended \\(cancelled\\)`));
  // Every closed run's entries are gone; the one Claude reported itself (c) too.
  assert.deepEqual(readdirSync(bg), []);
  hook("alice", "Stop", { session_id: "alice-bg2", last_assistant_message: "Started them." });
});

await step("a handoff comes first in the teammate's next message, and they can take it over", async () => {
  const a = await signIn(`alice-${run}@hooks.local`);
  const ctx = await core.loadCtx(a.sb, a.userId, { workspace: slug, session: null });
  await core.createHandoff(ctx, {
    to: "bob", title: "Finish the ingest stress test", summary: "The stress test is running; nothing analysed yet.",
    nextSteps: "Read the run's log tail and write up p99 latency.",
  });
  const b = hook("bob", "UserPromptSubmit", { session_id: "bob-1", prompt: "hi" });
  assert.match(b.context, /^── handed to you ──\nhandoff #1 from alice · just now · "Finish the ingest stress test"/);
  assert.match(b.context, new RegExp(`run #${bgRun} · alice · "Stress test the ingest service" .*\\(you're watching\\)`));
  assert.match(cli("bob", ["handoffs", "1", "--accept"]), /You took over handoff #1/);
  assert.doesNotMatch(hook("bob", "UserPromptSubmit", { session_id: "bob-1", prompt: "ok" }).context, /handed to you/);
  await core.updateRun(ctx, (await core.getRun(ctx, bgRun)).id, { status: "succeeded", exitCode: 0, progress: "p99 41ms" });
  const after = hook("bob", "UserPromptSubmit", { session_id: "bob-1", prompt: "how did it go?" });
  assert.match(after.context, new RegExp(`run #${bgRun} "Stress test the ingest service" on \\S+ succeeded after \\d+s; last: "p99 41ms"  ← mentions you`));
});

await step("after Claude accepts a handoff, the next hook starts watching its Modal job", async () => {
  // A fake modal CLI and a detached job of alice's on it.
  copyFileSync(join(process.cwd(), "scripts/lib/fake-modal.mjs"), join(root, "modal"));
  chmodSync(join(root, "modal"), 0o755);
  const state = join(root, "modal-state.json");
  const app = `ap-hook${run}`;
  const setApp = (a: Record<string, unknown>) => writeFileSync(state, JSON.stringify({ apps: { [app]: a } }));
  setApp({ state: "ephemeral (detached)", stopped_by: null, logs: ["epoch 2/5"] });
  Object.assign(process.env, {
    FAKE_MODAL_STATE: state, CONTEXTER_MODAL_BIN: join(root, "modal"),
    CONTEXTER_MODAL_POLL_MS: "200", CONTEXTER_MODAL_IDLE_POLLS: "3",
  });
  const a = await signIn(`alice-${run}@hooks.local`);
  const actx = await core.loadCtx(a.sb, a.userId, { workspace: slug, session: null });
  const r = await core.startRun(actx, { title: "detached sweep", host: "Modal" });
  await core.setRunModal(actx, r.id, { app_id: app, profile: "venice67" });
  const h = Number(/Handoff #(\d+)/.exec(await core.createHandoff(actx, {
    to: "bob", title: "Keep an eye on the sweep", summary: "The sweep runs detached on Modal; I'm out of usage.",
  }))![1]);

  // bob's Claude accepts through MCP (server side, nothing starts locally)…
  const b = await signIn(`bob-${run}@hooks.local`);
  const bctx = await core.loadCtx(b.sb, b.userId, { workspace: slug, session: null });
  assert.match(await core.resolveHandoff(bctx, h, "accept"), /watcher starts by itself at the end of this turn/);
  // …and the Stop hook at the end of that turn starts bob's watcher.
  hook("bob", "UserPromptSubmit", { session_id: "bob-1", prompt: "take over the sweep" });
  hook("bob", "Stop", { session_id: "bob-1", last_assistant_message: "Took over the sweep." });
  const pid = join(root, "bob/.home/modal-daemon.pid");
  const log = () => { try { return readFileSync(join(root, "bob/.home/modal-daemon.log"), "utf8"); } catch { return "(no watcher log)"; } };
  for (let i = 0; i < 200 && !(await core.getRun(actx, r.number)).watched_at; i++) await new Promise((res) => setTimeout(res, 150));
  const watched = await core.getRun(actx, r.number);
  assert.equal(watched.watcher_user, b.userId);
  assert.equal(watched.progress, "epoch 2/5", `the watcher reported; its log:\n${log()}`);
  assert.ok(existsSync(pid), "bob's watcher is running");
  setApp({ state: "stopped", stopped_by: null, logs: ["epoch 5/5", "sweep done"] });
  for (let i = 0; i < 200 && (await core.getRun(actx, r.number)).status === "running"; i++) await new Promise((res) => setTimeout(res, 150));
  assert.equal((await core.getRun(actx, r.number)).status, "succeeded");
  for (let i = 0; i < 200 && existsSync(pid); i++) await new Promise((res) => setTimeout(res, 150));
  assert.ok(!existsSync(pid), "the watcher stops once nothing is left to watch");
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
