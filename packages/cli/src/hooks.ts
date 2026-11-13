// Claude Code hooks: the automatic half of the "one shared chat" illusion.
//   SessionStart      → team overview + shared memory + recent activity
//   UserPromptSubmit  → post the prompt as this session's task, inject what teammates did since
//                       the last message, what they're doing now, and any overlapping earlier work
//   PreToolUse        → before Claude edits a file: warn if a teammate is on it
//   PostToolUse       → after an edit went through: record the file on this session's task;
//                       after Claude starts a background command: register it as a run
//   Stop              → post a summary of Claude's reply, mark the task finished
// SessionStart, UserPromptSubmit and Stop also start the background Modal watcher when this
// member's machine has Modal jobs to watch (e.g. right after accepting a handoff).
//   SessionEnd        → close the session, release its locks
// Hooks must never get in the way: every failure is logged and the hook exits 0
// (exit 2 on UserPromptSubmit would block the user's prompt).
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import * as core from "../../../supabase/functions/_shared/contexter.ts";
import { getClient, requireUser } from "./client.ts";
import { home, loadConfig } from "./config.ts";
import { ensureModalDaemon } from "./modal.ts";

const CONTEXT_LIMIT = 9500; // Claude Code caps additionalContext at 10,000 characters

interface HookInput {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name: string;
  source?: string;
  prompt?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  reason?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

const stateDir = join(home, "sessions");
const statePath = (sid: string) => join(stateDir, `${sid.replace(/[^\w-]/g, "_")}.json`);

// warned: files this session was told a teammate recently changed (once per file per session).
// confirmed: "<file> <handles>" conflicts the user approved an edit through, because those teammates
// were editing the file right now (asked again when someone else starts editing it). pending: the
// conflict asked about per file, moved to confirmed once the edit runs (a rejected edit asks again).
interface SessionState {
  workspace: string; session: string; private?: boolean; warned?: string[]; confirmed?: string[];
  pending?: Record<string, string>;
}

function readState(sid: string): SessionState | null {
  try { return JSON.parse(readFileSync(statePath(sid), "utf8")); } catch { return null; }
}
function writeState(sid: string, s: SessionState) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(statePath(sid), JSON.stringify(s), { mode: 0o600 });
}

// The folder holding .contexter.json: the project root every member's paths are relative to.
export function projectRoot(cwd: string): string | undefined {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".contexter.json"))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

// Which workspace a project belongs to: a .contexter.json in the project (or a parent),
// then CONTEXTER_WORKSPACE, then the CLI's active workspace.
export function projectWorkspace(cwd: string): string | undefined {
  const root = projectRoot(cwd);
  if (root) {
    try { return JSON.parse(readFileSync(join(root, ".contexter.json"), "utf8")).workspace; } catch { return undefined; }
  }
  return process.env.CONTEXTER_WORKSPACE ?? loadConfig().activeWorkspace?.slug;
}

// A file path as teammates see it: relative to the project root (or cwd), with / separators.
// undefined for files outside the project, which other machines can't share anyway.
export function projectPath(file: string, cwd: string): string | undefined {
  const root = projectRoot(cwd) ?? cwd;
  const rel = relative(root, isAbsolute(file) ? file : join(cwd, file));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
}

function emit(event: string, context: string) {
  if (!context.trim()) return;
  const text = context.length > CONTEXT_LIMIT ? `${context.slice(0, CONTEXT_LIMIT - 40)}\n… (truncated; use contexter tools)` : context;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
}

async function context(input: HookInput, opts: { create: boolean }) {
  const sb = getClient();
  const user = await requireUser(sb);
  const state = readState(input.session_id);
  const workspace = state?.workspace ?? projectWorkspace(input.cwd ?? process.cwd());
  if (!workspace) return null; // not a contexter project; stay silent
  if (!state && !opts.create) return null;
  const ctx = await core.loadCtx(sb, user.id, state
    ? { workspace, session: state.session }
    : { workspace, client: "claude-code", externalId: input.session_id, title: basename(input.cwd ?? "") });
  if (!state) writeState(input.session_id, { workspace: ctx.ws.slug, session: ctx.session! });
  return { ctx, state: readState(input.session_id)! };
}

// Never let the watcher get in the way of a hook: failures only go to the hook log.
async function startModalWatcher(ctx: core.Ctx, input: HookInput) {
  const cwd = input.cwd ?? process.cwd();
  await ensureModalDaemon(ctx.db, ctx.userId, projectRoot(cwd) ?? cwd).catch((err) => {
    appendFileSync(join(home, "hooks.log"), `${new Date().toISOString()} modal watcher: ${err instanceof Error ? err.message : err}\n`);
  });
}

async function sessionStart(input: HookInput) {
  const c = await context(input, { create: true });
  if (!c) return;
  const { ctx } = c;
  await startModalWatcher(ctx, input);
  // Mark the backlog as read: the memory context below already covers it.
  await core.feedDelta(ctx, 500);
  const [handed, overview, memory, runs, hint] = await Promise.all([
    core.handoffsBlock(ctx), core.overview(ctx), core.memoryContext(ctx), core.runsBlock(ctx), core.compactionHint(ctx),
  ]);
  emit("SessionStart", [
    `This project is the shared contexter workspace "${ctx.ws.slug}". Teammates use their own Claude on the same workspace; ` +
    "contexter keeps everyone in sync. Before each user message you'll receive a team feed block with what teammates and " +
    "their Claudes did. Use the contexter MCP tools to read and write shared units (always with expected_version), to record " +
    "reasoning (record), and to message teammates (mention). If the user's message starts with !private it is not shared.",
    handed, overview, memory, runs, hint,
  ].filter(Boolean).join("\n\n"));
}

async function userPromptSubmit(input: HookInput) {
  const c = await context(input, { create: true });
  if (!c) return;
  const { ctx, state } = c;
  await startModalWatcher(ctx, input);
  const prompt = input.prompt ?? "";
  const isPrivate = /^\s*!private\b/i.test(prompt);
  writeState(input.session_id, { ...state, private: isPrivate });
  const shared = !isPrivate && prompt.trim() ? prompt : "";
  const promptEvent = shared ? await core.postPrompt(ctx, shared) : null;
  await core.startTask(ctx, shared || null, promptEvent);
  const [delta, now, overlap, hint, handed, runs] = await Promise.all([
    core.feedDelta(ctx), core.workInProgress(ctx), shared ? core.overlapWarning(ctx, shared) : "", core.compactionHint(ctx),
    core.handoffsBlock(ctx), core.runsBlock(ctx),
  ]);
  emit("UserPromptSubmit", [
    isPrivate ? "[contexter] This message is private: it is not shared with the team. Don't post it." : "",
    handed, overlap, delta, now, runs, hint,
  ].filter(Boolean).join("\n\n"));
}

// Final assistant text and touched files of the last turn, from the transcript (JSONL).
export function lastTurn(transcriptPath: string): { text: string; files: string[] } {
  const lines = readFileSync(transcriptPath, "utf8").trim().split("\n");
  let text = "";
  const files = new Set<string>();
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: { type?: string; message?: { content?: unknown } };
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    const content = entry.message?.content;
    if (entry.type === "user") {
      // A real user message (not a tool result) marks the start of this turn.
      const isToolResult = Array.isArray(content) && content.some((b: { type?: string }) => b.type === "tool_result");
      if (!isToolResult) break;
      continue;
    }
    if (entry.type !== "assistant" || !Array.isArray(content)) continue;
    for (const block of content as { type: string; text?: string; name?: string; input?: Record<string, unknown> }[]) {
      if (block.type === "text" && !text && block.text?.trim()) text = block.text;
      if (block.type === "tool_use" && ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(block.name ?? "")) {
        const p = block.input?.file_path ?? block.input?.notebook_path;
        if (typeof p === "string") files.add(p);
      }
    }
  }
  return { text, files: [...files] };
}

export function summarize(text: string): string {
  const plain = text.replace(/```[\s\S]*?```/g, " ").replace(/[#*_`>|-]+/g, " ").replace(/\s+/g, " ").trim();
  const sentences = plain.match(/[^.!?]+[.!?]+/g) ?? [plain];
  return core.truncate(sentences.slice(0, 2).join(" "), 300);
}

async function stop(input: HookInput) {
  if (input.stop_hook_active) return;
  const c = await context(input, { create: false });
  if (!c) return;
  await core.finishTask(c.ctx);
  // Claude may have accepted a handoff this turn: start watching its Modal jobs now.
  await startModalWatcher(c.ctx, input);
  if (c.state.private) return;
  const turn = input.transcript_path && existsSync(input.transcript_path)
    ? lastTurn(input.transcript_path) : { text: "", files: [] };
  const text = input.last_assistant_message || turn.text;
  if (!text.trim() && !turn.files.length) return;
  const cwd = input.cwd ?? process.cwd();
  const files = turn.files.map((f) => projectPath(f, cwd) ?? f);
  await core.postReply(c.ctx, { summary: summarize(text) || "(worked on files)", text, files });
}

// The file a file-editing tool call is about, relative to the project root.
async function fileTool(input: HookInput) {
  const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (typeof file !== "string") return null;
  const path = projectPath(file, input.cwd ?? process.cwd());
  if (!path) return null;
  const c = await context(input, { create: false });
  return c ? { ...c, path } : null;
}

// Before Claude edits a file: warn if a teammate changed it recently (once per file per session) or
// is editing it right now. In the second case the user is asked to confirm the edit (once per file
// and set of teammates). Nothing is recorded yet: the edit may still be rejected.
async function preToolUse(input: HookInput) {
  const t = await fileTool(input);
  if (!t) return;
  const { state, path } = t;
  const { warn, activeBy } = await core.touchFile(t.ctx, path, false);
  if (!warn) return;
  const warned = state.warned ?? [];
  const confirmed = state.confirmed ?? [];
  const conflict = activeBy.length ? `${path} ${[...activeBy].sort().join(",")}` : "";
  const ask = conflict && !confirmed.includes(conflict);
  if (!ask && warned.includes(path)) return;
  writeState(input.session_id, ask
    ? { ...state, pending: { ...state.pending, [path]: conflict } }
    : { ...state, warned: [...warned, path].slice(-200) });
  const out: Record<string, unknown> = { hookEventName: "PreToolUse", additionalContext: warn };
  if (ask) {
    out.permissionDecision = "ask";
    out.permissionDecisionReason = `contexter: ${activeBy.join(", ")} ${activeBy.length > 1 ? "are" : "is"} editing ${path} right now. Edit it anyway?`;
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));
}

// After a tool call ran (PostToolUse only fires for calls that did): a background command becomes a
// run; an edit records its file on this session's task, so teammates see it live. Private turns
// share neither.
async function postToolUse(input: HookInput) {
  if (input.tool_name === "Bash") return backgroundCommand(input);
  const t = await fileTool(input);
  if (!t) return;
  const { state, path } = t;
  const conflict = state.pending?.[path];
  if (conflict) {
    // The user approved the edit through a live conflict: don't ask again for this one.
    const { [path]: _, ...pending } = state.pending!;
    writeState(input.session_id, {
      ...state, pending,
      confirmed: [...(state.confirmed ?? []), conflict].slice(-200),
      warned: (state.warned ?? []).includes(path) ? state.warned : [...(state.warned ?? []), path].slice(-200),
    });
  }
  if (!state.private) await core.touchFile(t.ctx, path, true);
}

// A command Claude started in the background is probably a long job: register it as a run so the
// team sees it, and ask Claude to report how it ends. Commands already under `contexter run`
// register themselves.
async function backgroundCommand(input: HookInput) {
  const command = input.tool_input?.command;
  if (input.tool_input?.run_in_background !== true || typeof command !== "string") return;
  if (/\bcontexter(\.mjs)?["']?\s+run\b/.test(command)) return;
  const c = await context(input, { create: false });
  if (!c || c.state.private) return;
  const description = input.tool_input?.description;
  const run = await core.startRun(c.ctx, {
    title: typeof description === "string" && description.trim() ? description : core.truncate(command, 120),
    host: hostname(), command,
  });
  emit("PostToolUse",
    `[contexter] This background command is now run #${run.number}, so teammates can see it. When you learn how it ` +
    `went (its output, or the user tells you), call contexter's update_run with run=${run.number}: status succeeded, ` +
    "failed or cancelled, exit_code, and a one-line progress. Update progress along the way if it's long.");
}

async function sessionEnd(input: HookInput) {
  const state = readState(input.session_id);
  if (!state) return;
  const sb = getClient();
  await requireUser(sb);
  await sb.rpc("end_session", { p_session: state.session });
  rmSync(statePath(input.session_id), { force: true });
}

const handlers: Record<string, (i: HookInput) => Promise<void>> = {
  "session-start": sessionStart,
  "user-prompt-submit": userPromptSubmit,
  "pre-tool-use": preToolUse,
  "post-tool-use": postToolUse,
  stop,
  "session-end": sessionEnd,
};
export const HOOK_EVENTS = {
  SessionStart: "session-start",
  UserPromptSubmit: "user-prompt-submit",
  PreToolUse: "pre-tool-use",
  PostToolUse: "post-tool-use",
  Stop: "stop",
  SessionEnd: "session-end",
} as const;
// Events that only fire for some tools: the file-editing tools.
export const HOOK_MATCHERS: Partial<Record<keyof typeof HOOK_EVENTS, string>> = {
  PreToolUse: "Edit|Write|MultiEdit|NotebookEdit",
  PostToolUse: "Edit|Write|MultiEdit|NotebookEdit|Bash",
};

export async function runHook(name: string) {
  try {
    const raw = readFileSync(0, "utf8");
    const input = JSON.parse(raw || "{}") as HookInput;
    const handler = handlers[name];
    if (!handler) throw new Error(`unknown hook ${name}`);
    await handler(input);
  } catch (err) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    appendFileSync(join(home, "hooks.log"), `${new Date().toISOString()} ${name}: ${err instanceof Error ? err.message : err}\n`);
  }
  process.exit(0);
}
