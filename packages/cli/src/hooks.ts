// Claude Code hooks: the automatic half of the "one shared chat" illusion.
//   SessionStart      → team overview + shared memory + recent activity
//   UserPromptSubmit  → post the prompt as this session's task, inject what teammates did since
//                       the last message, what they're doing now, and any overlapping earlier work
//   PreToolUse        → before Claude edits a file: record it, warn if a teammate is on it
//   Stop              → post a summary of Claude's reply, mark the task finished
//   SessionEnd        → close the session, release its locks
// Hooks must never get in the way: every failure is logged and the hook exits 0
// (exit 2 on UserPromptSubmit would block the user's prompt).
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import * as core from "../../../supabase/functions/_shared/contexter.ts";
import { getClient, requireUser } from "./client.ts";
import { home, loadConfig } from "./config.ts";

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

// warned: files this session was already warned about (once per file per session).
interface SessionState { workspace: string; session: string; private?: boolean; warned?: string[] }

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

async function sessionStart(input: HookInput) {
  const c = await context(input, { create: true });
  if (!c) return;
  const { ctx } = c;
  // Mark the backlog as read: the memory context below already covers it.
  await core.feedDelta(ctx, 500);
  const [overview, memory, hint] = await Promise.all([core.overview(ctx), core.memoryContext(ctx), core.compactionHint(ctx)]);
  emit("SessionStart", [
    `This project is the shared contexter workspace "${ctx.ws.slug}". Teammates use their own Claude on the same workspace; ` +
    "contexter keeps everyone in sync. Before each user message you'll receive a team feed block with what teammates and " +
    "their Claudes did. Use the contexter MCP tools to read and write shared units (always with expected_version), to record " +
    "reasoning (record), and to message teammates (mention). If the user's message starts with !private it is not shared.",
    overview, memory, hint,
  ].filter(Boolean).join("\n\n"));
}

async function userPromptSubmit(input: HookInput) {
  const c = await context(input, { create: true });
  if (!c) return;
  const { ctx, state } = c;
  const prompt = input.prompt ?? "";
  const isPrivate = /^\s*!private\b/i.test(prompt);
  writeState(input.session_id, { ...state, private: isPrivate });
  const shared = !isPrivate && prompt.trim() ? prompt : "";
  await Promise.all([shared ? core.postPrompt(ctx, shared) : null, core.startTask(ctx, shared || null)]);
  const [delta, now, overlap, hint] = await Promise.all([
    core.feedDelta(ctx), core.workInProgress(ctx), shared ? core.overlapWarning(ctx, shared) : "", core.compactionHint(ctx),
  ]);
  emit("UserPromptSubmit", [
    isPrivate ? "[contexter] This message is private: it is not shared with the team. Don't post it." : "",
    overlap, delta, now, hint,
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
  if (c.state.private) return;
  const turn = input.transcript_path && existsSync(input.transcript_path)
    ? lastTurn(input.transcript_path) : { text: "", files: [] };
  const text = input.last_assistant_message || turn.text;
  if (!text.trim() && !turn.files.length) return;
  const cwd = input.cwd ?? process.cwd();
  const files = turn.files.map((f) => projectPath(f, cwd) ?? f);
  await core.postReply(c.ctx, { summary: summarize(text) || "(worked on files)", text, files });
}

// Before Claude edits a file: record it on this session's task (teammates see it live; not on
// private turns) and, once per file per session, warn if a teammate is editing it now or changed it
// recently. When someone is editing it right now, the user is asked to confirm the edit.
async function preToolUse(input: HookInput) {
  const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (typeof file !== "string") return;
  const c = await context(input, { create: false });
  if (!c) return;
  const path = projectPath(file, input.cwd ?? process.cwd());
  if (!path) return;
  const { warn, activeBy } = await core.touchFile(c.ctx, path, !c.state.private);
  const warned = c.state.warned ?? [];
  if (!warn || warned.includes(path)) return;
  writeState(input.session_id, { ...c.state, warned: [...warned, path].slice(-200) });
  const out: Record<string, unknown> = { hookEventName: "PreToolUse", additionalContext: warn };
  if (activeBy.length) {
    out.permissionDecision = "ask";
    out.permissionDecisionReason = `contexter: ${activeBy.join(", ")} ${activeBy.length > 1 ? "are" : "is"} editing ${path} right now. Edit it anyway?`;
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));
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
  stop,
  "session-end": sessionEnd,
};
export const HOOK_EVENTS = {
  SessionStart: "session-start",
  UserPromptSubmit: "user-prompt-submit",
  PreToolUse: "pre-tool-use",
  Stop: "stop",
  SessionEnd: "session-end",
} as const;
// Events that only fire for some tools: the file-editing tools.
export const HOOK_MATCHERS: Partial<Record<keyof typeof HOOK_EVENTS, string>> = {
  PreToolUse: "Edit|Write|MultiEdit|NotebookEdit",
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
