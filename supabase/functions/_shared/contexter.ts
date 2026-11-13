// contexter core: workspace operations and feed formatting shared by the MCP server (Deno)
// and the CLI/hooks (Node). No runtime imports: callers pass in a Supabase client scoped to
// the signed-in user, so RLS decides what every call can see and change.

// deno-lint-ignore no-explicit-any
type Any = any;
export interface Db {
  from(table: string): Any;
  rpc(fn: string, args?: Record<string, unknown>): Any;
}

export class ContexterError extends Error {}

export type Client = "claude-code" | "claude-chat" | "cli" | "other";

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  template: string;
  manifest: Record<string, Any>;
}

export interface Ctx {
  db: Db;
  userId: string;
  ws: Workspace;
  me: { handle: string; role: string };
  handles: Map<string, string>; // user_id → handle
  session?: string; // contexter session id, when this caller has one
}

export interface Unit {
  id: string;
  collection: string;
  key: string;
  kind: string;
  status: string;
  position: number | null;
  owner_id: string | null;
  current_version: number;
  lock_holder: string | null;
  lock_expires_at: string | null;
}

export interface Event {
  id: number;
  author_id: string;
  session_id: string | null;
  kind: string;
  payload: Record<string, Any>;
  mentions: string[];
  created_at: string;
}

const RECORD_LETTERS: Record<string, string> = {
  decision: "D", rationale: "R", alternative: "A", finding: "F", question: "Q", session: "S",
};
export const RECORD_TYPES = Object.keys(RECORD_LETTERS) as [string, ...string[]];

// Budgets for text injected into Claude's context.
const FEED_CHAR_BUDGET = 6000;
const COMPACT_AFTER_EVENTS = 40;

// ─────────────────────────────────────────────────────────────── helpers

// Query results are untyped here (no generated DB types shared across runtimes); callers annotate.
function unwrap(res: { data: Any; error: { message: string; hint?: string | null } | null }): Any {
  if (res.error) {
    throw new ContexterError(res.error.hint ? `${res.error.message} (${res.error.hint})` : res.error.message);
  }
  return res.data;
}

export function truncate(text: string, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export const refOf = (u: { collection: string; key: string }) => `${u.collection}/${u.key}`;

export function parseRef(ref: string): { collection: string; key: string } {
  const m = /^([a-z0-9_-]+)\/([a-z0-9_.-]+)$/.exec(ref.trim());
  if (!m) throw new ContexterError(`"${ref}" is not a unit ref; use <collection>/<key>, e.g. sections/method`);
  return { collection: m[1], key: m[2] };
}

export const recordRef = (r: { type: string; number: number }) =>
  `${RECORD_LETTERS[r.type] ?? "?"}-${String(r.number).padStart(4, "0")}`;

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? "just now" : `${duration(s)} ago`;
}

function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) {
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return m && h < 10 ? `${h}h${m}m` : `${h}h`;
  }
  return `${Math.round(s / 86400)}d`;
}

// @handles in text that belong to this workspace.
export function parseMentions(text: string, handles: Iterable<string>): string[] {
  const known = new Set(handles);
  const found = new Set<string>();
  for (const m of text.matchAll(/(^|[^\w@])@([a-z0-9_-]{2,32})\b/gi)) {
    const h = m[2].toLowerCase();
    if (known.has(h)) found.add(h);
  }
  return [...found];
}

// ─────────────────────────────────────────────────────────────── context

// Pick the workspace for this call: explicit slug, then the user's saved default, then their
// only workspace. Stateless clients (the MCP server) rely on the saved default.
export async function resolveWorkspace(db: Db, userId: string, slug?: string): Promise<Workspace> {
  const cols = "id, slug, name, template, manifest";
  if (slug) {
    const ws = unwrap(await db.from("workspaces").select(cols).eq("slug", slug).maybeSingle());
    if (!ws) throw new ContexterError(`No workspace "${slug}" that you're a member of.`);
    return ws;
  }
  const profile = unwrap(await db.from("profiles").select("active_workspace").eq("user_id", userId).maybeSingle());
  if (profile?.active_workspace) {
    const ws = unwrap(await db.from("workspaces").select(cols).eq("id", profile.active_workspace).maybeSingle());
    if (ws) return ws;
  }
  const all = unwrap(await db.from("workspaces").select(cols).order("created_at")) as Workspace[];
  if (all.length === 1) return all[0];
  if (!all.length) throw new ContexterError("You aren't in any workspace yet. Create one with `contexter init` or join with an invite code.");
  throw new ContexterError(`You're in several workspaces (${all.map((w) => w.slug).join(", ")}). Pass "workspace" or call use_workspace first.`);
}

export async function setActiveWorkspace(db: Db, userId: string, wsId: string) {
  unwrap(await db.from("profiles").upsert({ user_id: userId, active_workspace: wsId, updated_at: new Date().toISOString() }));
}

export async function loadCtx(
  db: Db, userId: string,
  opts: { workspace?: string; client?: Client; externalId?: string; title?: string; session?: string | null } = {},
): Promise<Ctx> {
  const ws = await resolveWorkspace(db, userId, opts.workspace);
  const members = unwrap(await db.from("members").select("user_id, handle, role").eq("workspace_id", ws.id)) as
    { user_id: string; handle: string; role: string }[];
  const me = members.find((m) => m.user_id === userId);
  if (!me) throw new ContexterError(`You're not a member of ${ws.slug}.`);
  const ctx: Ctx = { db, userId, ws, me, handles: new Map(members.map((m) => [m.user_id, m.handle])) };
  if (opts.session !== undefined) {
    ctx.session = opts.session ?? undefined;
  } else if (opts.client) {
    const s = unwrap(await db.rpc("ensure_session", {
      p_workspace: ws.id, p_client: opts.client, p_title: opts.title ?? null, p_external_id: opts.externalId ?? null,
    }).single()) as { id: string };
    ctx.session = s.id;
  }
  return ctx;
}

// ─────────────────────────────────────────────────────────────── feed formatting

export function describeEvent(e: Event, ctx: Pick<Ctx, "handles" | "userId">): string {
  const who = e.author_id === ctx.userId ? "you (another session)" : ctx.handles.get(e.author_id) ?? "someone";
  const p = e.payload ?? {};
  const unit = p.collection ? `${p.collection}/${p.key}` : "a unit";
  let what: string;
  switch (e.kind) {
    case "prompt": what = `asked: "${truncate(p.text ?? "", 400)}"`; break;
    case "reply": {
      const files = Array.isArray(p.files) && p.files.length ? ` [files: ${p.files.slice(0, 6).join(", ")}]` : "";
      what = `→ their Claude: ${truncate(p.summary || p.text || "", 500)}${files}`;
      break;
    }
    case "edit": what = `edited ${unit} (v${p.from}→v${p.to}): ${truncate(p.summary ?? "", 300)}`; break;
    case "record": what = `recorded ${recordRef(p as Any)} ${p.type}: ${truncate(p.title ?? "", 200)}`; break;
    case "status": what = `moved ${unit} ${p.from} → ${p.to}`; break;
    case "lock":
      what = p.action === "claimed" ? `is editing ${unit}`
        : p.action === "broken" ? `broke a lock on ${unit}${p.reason ? ` (${truncate(p.reason, 120)})` : ""}`
        : `released ${unit}`;
      break;
    case "mention": what = `to ${(e.mentions ?? []).map((h) => `@${h}`).join(" ")}: "${truncate(p.text ?? "", 400)}"`; break;
    case "member": what = `${p.action} the workspace`; break;
    case "presence": what = p.action === "started" ? `opened a ${p.client} session` : `closed their ${p.client} session`; break;
    case "compaction": what = `updated the shared memory (v${p.version})`; break;
    case "run": {
      const run = `run #${p.number} "${truncate(p.title ?? "", 120)}"${p.host ? ` on ${p.host}` : ""}`;
      const to = (e.mentions ?? []).map((h) => `@${h}`).join(" ");
      if (p.action === "started") what = `started ${run}${to ? ` (watching: ${to})` : ""}`;
      else if (p.action === "shared") what = `asked ${to} to watch ${run} (${p.status})`;
      else {
        const exit = p.exit_code != null && p.status !== "succeeded" ? ` (exit ${p.exit_code})` : "";
        const after = p.seconds != null ? ` after ${duration(p.seconds)}` : "";
        const last = p.progress ? `; last: "${truncate(p.progress, 160)}"` : "";
        what = `${run} ${p.status}${exit}${after}${last}`;
      }
      break;
    }
    case "handoff": {
      const h = `handoff #${p.number} "${truncate(p.title ?? "", 160)}"`;
      const to = (e.mentions ?? []).map((m) => `@${m}`).join(" ");
      what = p.action === "created" ? `handed off ${h} to ${to || "anyone who picks it up"}`
        : p.action === "accepted" ? `took over ${h}`
        : `${p.action} ${h}`;
      break;
    }
    default: what = truncate(JSON.stringify(p), 200);
  }
  return `• ${who} · ${ago(e.created_at)} · ${what}`;
}

// Turn feed events into the block injected into Claude's context. Mentions of the reader come
// first; presence noise is dropped; the rest is newest-last within a character budget.
export function formatFeed(events: Event[], ctx: Ctx, heading = "team feed since your last message"): string {
  const useful = events.filter((e) => e.kind !== "presence" || e.payload?.action === "started");
  if (!useful.length) return "";
  const forMe = useful.filter((e) => (e.mentions ?? []).includes(ctx.me.handle));
  const rest = useful.filter((e) => !forMe.includes(e));
  const lines: string[] = [];
  for (const e of forMe) lines.push(`${describeEvent(e, ctx)}  ← mentions you`);
  let used = lines.join("\n").length;
  const tail: string[] = [];
  for (const e of [...rest].reverse()) {
    const line = describeEvent(e, ctx);
    if (used + line.length > FEED_CHAR_BUDGET) {
      tail.unshift(`• … ${rest.length - tail.length} earlier events not shown; call team_feed for details`);
      break;
    }
    tail.unshift(line);
    used += line.length + 1;
  }
  return [`── ${heading} (${ctx.ws.slug}) ──`, ...lines, ...tail, "──"].join("\n");
}

// New teammate activity since this member last looked; advances their cursor.
export async function feedDelta(ctx: Ctx, limit = 60): Promise<string> {
  const events = unwrap(await ctx.db.rpc("pull_feed", {
    p_workspace: ctx.ws.id, p_limit: limit, p_session: ctx.session ?? null,
  })) as Event[];
  return formatFeed(events, ctx);
}

export async function teamFeed(ctx: Ctx, opts: { limit?: number; member?: string; unit?: string; before?: number }) {
  let q = ctx.db.from("events").select("*").eq("workspace_id", ctx.ws.id).order("id", { ascending: false })
    .limit(Math.min(opts.limit ?? 30, 200));
  if (opts.before) q = q.lt("id", opts.before);
  if (opts.member) {
    const uid = [...ctx.handles].find(([, h]) => h === opts.member)?.[0];
    if (!uid) throw new ContexterError(`No member "${opts.member}"`);
    q = q.eq("author_id", uid);
  }
  if (opts.unit) {
    const { collection, key } = parseRef(opts.unit);
    q = q.contains("payload", { collection, key });
  }
  const events = (unwrap(await q) as Event[]).reverse();
  if (!events.length) return "No matching events.";
  return events.map((e) => `[${e.id}] ${describeEvent(e, ctx)}`).join("\n");
}

// ─────────────────────────────────────────────────────────────── overview & presence

export async function listUnits(ctx: Ctx): Promise<Unit[]> {
  return unwrap(await ctx.db.from("units").select("*").eq("workspace_id", ctx.ws.id)
    .order("collection").order("position", { nullsFirst: false }).order("key"));
}

interface SessionRow {
  id: string;
  user_id: string;
  client: string;
  title: string | null;
  last_seen_at: string;
  current_task: string | null;
  task_started_at: string | null;
  task_finished_at: string | null;
  task_files: string[];
}

// Same rule as private.task_is_live: mid-task, and seen within the last hour (10 minutes for chat,
// whose tasks only finish through post_turn, which Claude skips for replies that did no real work).
const TASK_LIVE_MS = 60 * 60_000;
const CHAT_TASK_LIVE_MS = 10 * 60_000;
const isLive = (s: SessionRow) =>
  !!s.task_started_at && !s.task_finished_at &&
  Date.now() - new Date(s.last_seen_at).getTime() < (s.client === "claude-chat" ? CHAT_TASK_LIVE_MS : TASK_LIVE_MS);

const whoIs = (ctx: Pick<Ctx, "handles" | "userId">, userId: string) =>
  userId === ctx.userId ? "you (another session)" : ctx.handles.get(userId) ?? "someone";

const fileList = (files: string[], max = 5) =>
  files.length ? ` · files: ${files.slice(-max).join(", ")}${files.length > max ? ` (+${files.length - max} more)` : ""}` : "";

function taskLine(ctx: Ctx, s: SessionRow): string {
  const who = whoIs(ctx, s.user_id);
  const task = s.current_task ? `"${truncate(s.current_task, 200)}"` : "something private";
  if (isLive(s)) return `${who} is working on ${task} (started ${ago(s.task_started_at!)}, ${s.client})${fileList(s.task_files)}`;
  if (s.task_finished_at && s.current_task) {
    return `${who} is active in ${s.client}; last finished ${task} ${ago(s.task_finished_at)}${fileList(s.task_files)}`;
  }
  return `${who} is active in ${s.client}${s.title ? ` ("${truncate(s.title, 60)}")` : ""}, seen ${ago(s.last_seen_at)}`;
}

// Open sessions other than the caller's that are mid-task or were seen in the last 15 minutes.
async function otherSessions(ctx: Ctx): Promise<SessionRow[]> {
  const since = new Date(Date.now() - TASK_LIVE_MS).toISOString();
  const rows = unwrap(await ctx.db.from("sessions")
    .select("id, user_id, client, title, last_seen_at, current_task, task_started_at, task_finished_at, task_files")
    .eq("workspace_id", ctx.ws.id).is("ended_at", null).gt("last_seen_at", since)
    .order("last_seen_at", { ascending: false })) as SessionRow[];
  const recent = Date.now() - 15 * 60_000;
  return rows.filter((s) => s.id !== ctx.session && (isLive(s) || new Date(s.last_seen_at).getTime() > recent));
}

// Teammates' tasks in progress right now, for the block injected before every message.
export async function workInProgress(ctx: Ctx): Promise<string> {
  const live = (await otherSessions(ctx)).filter(isLive);
  if (!live.length) return "";
  return [
    `── in progress right now (${ctx.ws.slug}) ──`,
    ...live.map((s) => `• ${taskLine(ctx, s)}`),
    "Don't start the same work: if the user's request overlaps one of these, say so and suggest coordinating (mention).",
    "──",
  ].join("\n");
}

export async function presence(ctx: Ctx): Promise<string[]> {
  const [sessions, units] = await Promise.all([
    otherSessions(ctx),
    ctx.db.from("units").select("collection, key, lock_holder, lock_expires_at")
      .eq("workspace_id", ctx.ws.id).not("lock_holder", "is", null).gt("lock_expires_at", new Date().toISOString()),
  ]);
  const lines = sessions.map((s) => taskLine(ctx, s));
  for (const u of unwrap(units) as Any[]) {
    const who = u.lock_holder === ctx.userId ? "you" : ctx.handles.get(u.lock_holder) ?? "someone";
    lines.push(`${who} holds the lock on ${refOf(u)} until ${new Date(u.lock_expires_at).toISOString().slice(11, 16)} UTC`);
  }
  return lines;
}

export async function overview(ctx: Ctx): Promise<string> {
  const [units, questions, here] = await Promise.all([
    listUnits(ctx),
    ctx.db.from("records").select("type, number, title").eq("workspace_id", ctx.ws.id)
      .eq("type", "question").eq("status", "open").order("number"),
    presence(ctx),
  ]);
  const rules: string[] = ctx.ws.manifest?.rules ?? [];
  const out = [
    `Workspace: ${ctx.ws.name} (${ctx.ws.slug}) · template ${ctx.ws.template} · you are ${ctx.me.handle} (${ctx.me.role})`,
    `Members: ${[...ctx.handles.values()].join(", ")}`,
  ];
  if (rules.length) out.push("", "Rules every member's Claude follows:", ...rules.map((r) => `- ${r}`));
  out.push("", "Units (ref · status · version · owner):");
  for (const u of units) {
    const owner = u.owner_id ? ` · ${ctx.handles.get(u.owner_id) ?? "?"}` : "";
    out.push(`- ${refOf(u)} · ${u.status} · v${u.current_version}${owner}`);
  }
  if (!units.length) out.push("- (none yet; create one with create_unit)");
  const qs = unwrap(questions) as Any[];
  if (qs.length) out.push("", "Open questions:", ...qs.map((q) => `- ${recordRef(q)} ${q.title}`));
  if (here.length) out.push("", "Right now:", ...here.map((l) => `- ${l}`));
  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────── runs

export interface Run {
  id: string;
  number: number;
  started_by: string;
  title: string;
  host: string | null;
  command: string | null;
  reporter: "wrapper" | "claude" | "modal";
  status: "running" | "succeeded" | "failed" | "cancelled";
  progress: string | null;
  log_tail: string | null;
  exit_code: number | null;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
  external: { modal?: ModalJob };
  watcher_user: string | null;
  watched_at: string | null;
  watch_error: string | null;
}

// A job running on Modal: enough to find it again from any machine with that Modal profile.
export interface ModalJob {
  app_id: string;
  profile?: string;
  environment?: string;
}

export const RUN_STATUSES = ["running", "succeeded", "failed", "cancelled"] as const;
// `contexter run` reports every minute; this much silence means the job or its machine is gone.
const HEARTBEAT_STALE_MS = 5 * 60_000;
// Finished runs stay in the runs block this long for the people they matter to.
const RUN_RECENT_MS = 2 * 60 * 60_000;

export async function startRun(ctx: Ctx, run: {
  title: string; host?: string; command?: string; watchers?: string[]; reporter?: "wrapper" | "claude" | "modal";
}): Promise<Run> {
  return unwrap(await ctx.db.rpc("start_run", {
    p_workspace: ctx.ws.id, p_title: run.title, p_host: run.host ?? null, p_command: run.command ?? null,
    p_session: ctx.session ?? null, p_watchers: run.watchers ?? [], p_reporter: run.reporter ?? "claude",
  }).single());
}

export async function getRun(ctx: Ctx, number: number): Promise<Run> {
  const r = unwrap(await ctx.db.from("runs").select("*").eq("workspace_id", ctx.ws.id).eq("number", number).maybeSingle());
  if (!r) throw new ContexterError(`No run #${number} in ${ctx.ws.slug}. The runs tool lists them.`);
  return r;
}

export async function updateRun(ctx: Pick<Ctx, "db">, runId: string, report: {
  status?: string; progress?: string; logTail?: string; exitCode?: number;
}): Promise<Run> {
  return unwrap(await ctx.db.rpc("update_run", {
    p_run: runId, p_status: report.status ?? null, p_progress: report.progress ?? null,
    p_log_tail: report.logTail ?? null, p_exit_code: report.exitCode ?? null,
  }).single());
}

// Record the Modal job behind a run. watch: this user's machine watches it from now on.
export async function setRunModal(ctx: Ctx, runId: string, job: ModalJob, watch = false): Promise<Run> {
  return unwrap(await ctx.db.rpc("set_run_modal", {
    p_run: runId, p_app_id: job.app_id, p_profile: job.profile ?? null, p_environment: job.environment ?? null,
    p_watch: watch,
  }).single());
}

// A watcher's check-in on a Modal job (error: why it couldn't look). false: no longer ours to watch.
export async function reportRunWatch(db: Db, runId: string, error?: string): Promise<boolean> {
  return unwrap(await db.rpc("report_run_watch", { p_run: runId, p_error: error ?? null })) === true;
}

// Running Modal jobs this user's machine should watch, across all their workspaces.
export async function modalRunsToWatch(db: Db, userId: string): Promise<Run[]> {
  return unwrap(await db.from("runs").select("*").eq("watcher_user", userId).eq("reporter", "modal").eq("status", "running"));
}

export async function watchRun(ctx: Ctx, number: number, handles: string[] = []) {
  const r = await getRun(ctx, number);
  unwrap(await ctx.db.rpc("watch_run", { p_run: r.id, p_handles: handles, p_session: ctx.session ?? null }).single());
  return handles.length
    ? `${handles.map((h) => `@${h}`).join(" ")} will hear about run #${number} on their next message, and again when it ends.`
    : `You're watching run #${number}; you'll hear when it ends.`;
}

async function watchedRunIds(ctx: Ctx): Promise<Set<string>> {
  const rows = unwrap(await ctx.db.from("run_watchers").select("run_id").eq("user_id", ctx.userId)) as { run_id: string }[];
  return new Set(rows.map((r) => r.run_id));
}

// How a running job is being looked after, as a suffix for its line.
function runHealth(ctx: Ctx, r: Run): string {
  const silent = Date.now() - new Date(r.updated_at).getTime();
  const modal = r.external?.modal;
  if (r.reporter === "claude") return ` · last checked ${ago(r.updated_at)}`;
  if (r.reporter === "wrapper") {
    if (silent <= HEARTBEAT_STALE_MS) return "";
    return modal
      ? ` · NO HEARTBEAT for ${duration(silent / 1000)}: the machine that started it is gone, but the Modal job may still be ` +
        "running. Nobody is watching it: hand it off (handoff) so a teammate's machine takes over watching it"
      : ` · NO HEARTBEAT for ${duration(silent / 1000)}: the job or its machine may have died`;
  }
  // Modal job watched from someone's machine.
  if (!r.watcher_user) return " · NOBODY IS WATCHING this Modal job: hand it off so a teammate's machine watches it";
  const by = r.watcher_user === ctx.userId ? "your machine" : `${ctx.handles.get(r.watcher_user) ?? "someone"}'s machine`;
  if (r.watch_error) return ` · ${by} can't check it: ${truncate(r.watch_error, 160)}`;
  if (!r.watched_at) return ` · waiting for ${by} to start watching it`;
  const unseen = Date.now() - new Date(r.watched_at).getTime();
  if (unseen > HEARTBEAT_STALE_MS) return ` · ${by} hasn't checked it for ${duration(unseen / 1000)} (its watcher isn't running)`;
  return ` · watched by ${by}, checked ${ago(r.watched_at)}`;
}

function runLine(ctx: Ctx, r: Run, watched: boolean): string {
  const who = r.started_by === ctx.userId ? "you" : ctx.handles.get(r.started_by) ?? "someone";
  const modal = r.external?.modal;
  const where = modal ? ` on Modal (${modal.app_id}${modal.profile ? `, profile ${modal.profile}` : ""})` : r.host ? ` on ${r.host}` : "";
  const head = `run #${r.number} · ${who} · "${truncate(r.title, 120)}"${where}`;
  const mark = watched ? " (you're watching)" : "";
  if (r.status === "running") {
    const health = runHealth(ctx, r);
    const progress = r.progress ? ` · ${truncate(r.progress, 160)}` : "";
    return `${head} · running ${duration((Date.now() - new Date(r.started_at).getTime()) / 1000)}${progress}${health}${mark}`;
  }
  const exit = r.exit_code != null && r.status !== "succeeded" ? ` (exit ${r.exit_code})` : "";
  const last = r.progress ? ` · last: "${truncate(r.progress, 160)}"` : "";
  return `${head} · ${r.status.toUpperCase()}${exit} ${ago(r.finished_at ?? r.updated_at)}${last}${mark}`;
}

// The team's running jobs, plus recently finished ones the reader started or watches, for the
// block injected before every message. "" when there's nothing to say.
export async function runsBlock(ctx: Ctx, max = 8): Promise<string> {
  const since = new Date(Date.now() - RUN_RECENT_MS).toISOString();
  const [rows, watched] = await Promise.all([
    ctx.db.from("runs").select("*").eq("workspace_id", ctx.ws.id)
      .or(`status.eq.running,finished_at.gt."${since}"`).order("updated_at", { ascending: false }).limit(40),
    watchedRunIds(ctx),
  ]);
  const runs = (unwrap(rows) as Run[]).filter((r) =>
    r.status === "running" || r.started_by === ctx.userId || watched.has(r.id));
  if (!runs.length) return "";
  // What the reader is involved in comes first.
  const mine = (r: Run) => r.started_by === ctx.userId || watched.has(r.id);
  runs.sort((a, b) => Number(mine(b)) - Number(mine(a)));
  const lines = runs.slice(0, max).map((r) => `• ${runLine(ctx, r, watched.has(r.id))}`);
  if (runs.length > max) lines.push(`• … ${runs.length - max} more; call the runs tool`);
  return [
    `── runs (${ctx.ws.slug}) ──`,
    ...lines,
    "Mention a failed or stalled run you started or watch to the user. Details and log tail: the runs tool with run=<number>.",
    "──",
  ].join("\n");
}

export async function listRuns(ctx: Ctx, limit = 20): Promise<string> {
  const [rows, watched] = await Promise.all([
    ctx.db.from("runs").select("*").eq("workspace_id", ctx.ws.id).order("number", { ascending: false }).limit(limit),
    watchedRunIds(ctx),
  ]);
  const runs = unwrap(rows) as Run[];
  if (!runs.length) return `No runs in ${ctx.ws.slug} yet. Start one with start_run, or wrap the command in \`contexter run --\`.`;
  return runs.map((r) => `- ${runLine(ctx, r, watched.has(r.id))}`).join("\n");
}

export async function runDetail(ctx: Ctx, number: number): Promise<string> {
  const r = await getRun(ctx, number);
  const watchers = unwrap(await ctx.db.from("run_watchers").select("user_id").eq("run_id", r.id)) as { user_id: string }[];
  const names = watchers.map((w) => ctx.handles.get(w.user_id) ?? "?");
  return [
    runLine(ctx, r, watchers.some((w) => w.user_id === ctx.userId)),
    r.command ? `command: ${r.command}` : "",
    `started ${new Date(r.started_at).toISOString()} · last report ${ago(r.updated_at)} · reported by ${
      r.reporter === "wrapper" ? "contexter run (heartbeat every minute)"
        : r.reporter === "modal" ? "a contexter watcher polling Modal every minute" : "Claude"}`,
    names.length ? `watching: ${names.join(", ")}` : "",
    r.log_tail ? `\n────── log tail ──────\n${r.log_tail}` : "(no log captured)",
  ].filter(Boolean).join("\n");
}

// ─────────────────────────────────────────────────────────────── handoffs

export interface Handoff {
  id: string;
  number: number;
  from_user: string;
  to_user: string | null;
  title: string;
  summary: string;
  next_steps: string | null;
  files: string[];
  status: string;
  created_at: string;
}

export async function createHandoff(ctx: Ctx, h: {
  to?: string; title: string; summary: string; nextSteps?: string; files?: string[];
}) {
  const row = unwrap(await ctx.db.rpc("create_handoff", {
    p_workspace: ctx.ws.id, p_to: h.to?.replace(/^@/, "") || null, p_title: h.title, p_summary: h.summary,
    p_next_steps: h.nextSteps ?? null, p_files: h.files ?? [], p_session: ctx.session ?? null,
  }).single()) as Handoff;
  const running = unwrap(await ctx.db.from("runs").select("number").eq("workspace_id", ctx.ws.id)
    .eq("started_by", ctx.userId).eq("status", "running")) as { number: number }[];
  const runs = running.length && h.to ? ` They now watch your running ${running.map((r) => `#${r.number}`).join(", ")}.` : "";
  return `Handoff #${row.number} is waiting for ${h.to ? `@${h.to.replace(/^@/, "")}` : "anyone on the team"}: ` +
    `their Claude brings it up first on their next message.${runs} Your unit locks pass to them when they accept.`;
}

export async function resolveHandoff(ctx: Ctx, number: number, action: "accept" | "decline" | "cancel") {
  const h = unwrap(await ctx.db.from("handoffs").select("id").eq("workspace_id", ctx.ws.id).eq("number", number).maybeSingle());
  if (!h) throw new ContexterError(`No handoff #${number} in ${ctx.ws.slug}.`);
  const status = { accept: "accepted", decline: "declined", cancel: "cancelled" }[action];
  const row = unwrap(await ctx.db.rpc("resolve_handoff", { p_handoff: h.id, p_action: status, p_session: ctx.session ?? null })
    .single()) as Handoff;
  if (action !== "accept") return `Handoff #${number} ${status}.`;
  const modal = (await modalRunsToWatch(ctx.db, ctx.userId)).filter((r) => r.external?.modal);
  return [
    `You took over handoff #${number}. Here it is again:`, "", handoffText(ctx, row, []),
    modal.length
      ? `\nThis user's machine now watches the Modal job(s) ${modal.map((r) => `run #${r.number} (${r.external.modal!.app_id})`).join(", ")}. ` +
        "In Claude Code the contexter watcher starts by itself at the end of this turn; anywhere else, run " +
        "`contexter modal daemon` in a folder where the modal CLI works. It needs the same Modal profile."
      : "",
  ].filter(Boolean).join("\n");
}

function handoffText(ctx: Ctx, h: Handoff, modal: Run[]): string {
  const from = ctx.handles.get(h.from_user) ?? "someone";
  return [
    `handoff #${h.number} from ${from} · ${ago(h.created_at)}${h.to_user ? "" : " · open to anyone"} · "${h.title}"`,
    `Where it stands: ${h.summary}`,
    h.next_steps ? `Next steps: ${h.next_steps}` : "",
    h.files.length ? `Files: ${h.files.join(", ")}` : "",
    modal.length
      ? `Modal jobs this user's machine will watch on accepting: ${modal.map((r) =>
        `run #${r.number} "${truncate(r.title, 80)}" (${r.external.modal!.app_id}${r.external.modal!.profile ? `, profile ${r.external.modal!.profile}` : ""})`).join("; ")}`
      : "",
  ].filter(Boolean).join("\n");
}

// Open handoffs the reader could take over: addressed to them, or to anyone (not their own).
export async function handoffsBlock(ctx: Ctx): Promise<string> {
  const rows = unwrap(await ctx.db.from("handoffs").select("*").eq("workspace_id", ctx.ws.id).eq("status", "open")
    .neq("from_user", ctx.userId).or(`to_user.eq.${ctx.userId},to_user.is.null`).order("number")) as Handoff[];
  if (!rows.length) return "";
  // The senders' running Modal jobs, which move to the reader's watcher on accepting.
  const modal = unwrap(await ctx.db.from("runs").select("*").eq("workspace_id", ctx.ws.id).eq("status", "running")
    .not("external->modal", "is", null)) as Run[];
  const movesWith = (h: Handoff) => modal.filter((r) =>
    r.watcher_user === h.from_user || (!r.watcher_user && r.started_by === h.from_user));
  return [
    "── handed to you ──",
    ...rows.slice(0, 3).map((h) => handoffText(ctx, h, movesWith(h))).join("\n\n").split("\n"),
    ...(rows.length > 3 ? [`… ${rows.length - 3} more open handoffs.`] : []),
    "A teammate passed this unfinished work to this user's Claude (for example because their usage limit ran out). " +
    "Bring it up first. If the user wants to take it over, call resolve_handoff with action accept (that moves the " +
    "sender's unit locks to this user and adds the sender's running runs to the ones this user watches), then carry on " +
    "from the next steps. If not, resolve it with action decline.",
    "──",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────── shared memory

export async function memoryStatus(ctx: Ctx) {
  return unwrap(await ctx.db.rpc("memory_status", { p_workspace: ctx.ws.id }).single()) as {
    version: number | null; summary: string | null; covers_up_to_event: number; events_since: number; latest_event: number;
  };
}

// What a fresh session needs: the team's running summary plus everything since it was written.
export async function memoryContext(ctx: Ctx): Promise<string> {
  const m = await memoryStatus(ctx);
  const events = unwrap(await ctx.db.from("events").select("*").eq("workspace_id", ctx.ws.id)
    .gt("id", m.covers_up_to_event).neq("kind", "presence").order("id", { ascending: false }).limit(80)) as Event[];
  const parts: string[] = [];
  parts.push(m.summary
    ? `── shared memory v${m.version} (team summary up to event ${m.covers_up_to_event}) ──\n${m.summary}`
    : "── shared memory ──\n(no summary yet)");
  const recent = formatFeed(events.reverse(), ctx, "since the summary");
  if (recent) parts.push(recent);
  return parts.join("\n\n");
}

export async function compactionHint(ctx: Ctx): Promise<string> {
  const m = await memoryStatus(ctx);
  if (m.events_since < COMPACT_AFTER_EVENTS) return "";
  return [
    `[contexter] The team's shared memory is ${m.events_since} events behind.`,
    `When this turn's work is done, call compact_memory with an updated summary (covers_up_to=${m.latest_event}):`,
    "merge the previous summary with the events since, keeping decisions, current state of each unit,",
    "open questions and who is doing what. Aim for under 600 words.",
  ].join(" ");
}

export async function compactMemory(ctx: Ctx, summary: string, coversUpTo: number) {
  return unwrap(await ctx.db.rpc("compact_memory", {
    p_workspace: ctx.ws.id, p_summary: summary, p_covers_up_to: coversUpTo, p_session: ctx.session ?? null,
  }).single()) as { version: number };
}

// ─────────────────────────────────────────────────────────────── units

export async function getUnit(ctx: Ctx, ref: string): Promise<Unit> {
  const { collection, key } = parseRef(ref);
  const u = unwrap(await ctx.db.from("units").select("*").eq("workspace_id", ctx.ws.id)
    .eq("collection", collection).eq("key", key).maybeSingle());
  if (!u) throw new ContexterError(`No unit ${ref}. Existing units are listed by get_overview.`);
  return u;
}

async function linkedRecords(ctx: Ctx, refs: string[]) {
  const out: Any[] = [];
  for (const ref of refs) {
    out.push(...unwrap(await ctx.db.from("records").select("type, number, title, body, status, created_at, author_id")
      // links is jsonb: pass JSON text (a JS array would be sent as a Postgres array literal).
      .eq("workspace_id", ctx.ws.id).contains("links", JSON.stringify([ref])).order("created_at")) as Any[]);
  }
  return out;
}

export async function readUnit(ctx: Ctx, ref: string, version?: number) {
  const u = await getUnit(ctx, ref);
  const v = version ?? u.current_version;
  const row = v > 0
    ? unwrap(await ctx.db.from("unit_versions").select("content, summary, author_id, created_at")
      .eq("unit_id", u.id).eq("version", v).maybeSingle())
    : null;
  const records = await linkedRecords(ctx, [ref]);
  const lock = u.lock_holder && u.lock_expires_at && new Date(u.lock_expires_at) > new Date()
    ? `locked by ${ctx.handles.get(u.lock_holder) ?? "?"} until ${u.lock_expires_at}` : "unlocked";
  const head = [
    `${ref} · ${u.status} · v${v}${v !== u.current_version ? ` (current is v${u.current_version})` : ""} · ${lock}`,
    row ? `last change by ${ctx.handles.get(row.author_id) ?? "?"} ${ago(row.created_at)}: ${row.summary}` : "no content yet",
    `To change it: write_unit with expected_version=${u.current_version}.`,
  ].join("\n");
  const why = records.length
    ? `\n\nReasoning linked to this unit:\n${records.map((r) => `- ${recordRef(r)} ${r.type} (${r.status}): ${r.title}`).join("\n")}`
    : "";
  return `${head}${why}\n\n────── content ──────\n${row?.content ?? ""}`;
}

export async function unitHistory(ctx: Ctx, ref: string) {
  const u = await getUnit(ctx, ref);
  const rows = unwrap(await ctx.db.from("unit_versions").select("version, summary, author_id, created_at")
    .eq("unit_id", u.id).order("version", { ascending: false }).limit(50)) as Any[];
  if (!rows.length) return `${ref} has no versions yet.`;
  return rows.map((r) => `v${r.version} · ${ctx.handles.get(r.author_id) ?? "?"} · ${ago(r.created_at)} · ${r.summary}`).join("\n");
}

export async function diffUnit(ctx: Ctx, ref: string, from: number, to?: number) {
  const u = await getUnit(ctx, ref);
  const target = to ?? u.current_version;
  const rows = unwrap(await ctx.db.from("unit_versions").select("version, content")
    .eq("unit_id", u.id).in("version", [from, target])) as { version: number; content: string }[];
  const a = rows.find((r) => r.version === from)?.content ?? "";
  const b = rows.find((r) => r.version === target)?.content ?? "";
  return `--- ${ref} v${from}\n+++ ${ref} v${target}\n${lineDiff(a, b)}`;
}

// Small LCS line diff; units are documents, not huge files.
export function lineDiff(a: string, b: string): string {
  const x = a.split("\n"), y = b.split("\n");
  const n = x.length, m = y.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push(`  ${x[i]}`); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(`- ${x[i++]}`);
    else out.push(`+ ${y[j++]}`);
  }
  while (i < n) out.push(`- ${x[i++]}`);
  while (j < m) out.push(`+ ${y[j++]}`);
  return out.join("\n");
}

export async function createUnit(ctx: Ctx, ref: string, opts: { status?: string; position?: number; owner?: string } = {}) {
  const { collection, key } = parseRef(ref);
  const owner = opts.owner ? [...ctx.handles].find(([, h]) => h === opts.owner)?.[0] : undefined;
  if (opts.owner && !owner) throw new ContexterError(`No member "${opts.owner}"`);
  unwrap(await ctx.db.from("units").insert({
    workspace_id: ctx.ws.id, collection, key, status: opts.status ?? "outline",
    kind: ctx.ws.manifest?.collections?.[collection]?.kind === "linked" ? "linked" : "managed",
    position: opts.position ?? null, owner_id: owner ?? null,
  }));
  unwrap(await ctx.db.from("events").insert({
    workspace_id: ctx.ws.id, session_id: ctx.session ?? null, author_id: ctx.userId, kind: "status",
    payload: { collection, key, from: null, to: opts.status ?? "outline", action: "created" },
  }));
  return `Created ${ref}.`;
}

export async function setStatus(ctx: Ctx, ref: string, status: string) {
  const u = await getUnit(ctx, ref);
  const allowed: string[] | undefined = ctx.ws.manifest?.collections?.[u.collection]?.statuses;
  if (allowed?.length && !allowed.includes(status)) {
    throw new ContexterError(`"${status}" isn't a status for ${u.collection}; use one of ${allowed.join(", ")}`);
  }
  unwrap(await ctx.db.from("units").update({ status, updated_at: new Date().toISOString() }).eq("id", u.id));
  return `${ref}: ${u.status} → ${status}`;
}

export async function claimUnit(ctx: Ctx, ref: string, minutes = 120, force = false, reason?: string) {
  const u = await getUnit(ctx, ref);
  const r = unwrap(await ctx.db.rpc("claim_unit", {
    p_unit: u.id, p_session: ctx.session ?? null, p_ttl: `${minutes} minutes`, p_force: force, p_reason: reason ?? null,
  }).single()) as Unit;
  return `You hold ${ref} until ${r.lock_expires_at}. Release it with release_unit when done.`;
}

export async function releaseUnit(ctx: Ctx, ref: string) {
  const u = await getUnit(ctx, ref);
  unwrap(await ctx.db.rpc("release_unit", { p_unit: u.id, p_session: ctx.session ?? null }).single());
  return `Released ${ref}.`;
}

export async function writeUnit(
  ctx: Ctx, ref: string, content: string, expectedVersion: number, summary: string, reasoning?: string,
) {
  const u = await getUnit(ctx, ref);
  const res = await ctx.db.rpc("write_unit", {
    p_unit: u.id, p_content: content, p_expected_version: expectedVersion, p_summary: summary, p_session: ctx.session ?? null,
  });
  if (res.error?.hint === "version_conflict") {
    throw new ContexterError(
      `${ref} changed since v${expectedVersion}; it's now v${u.current_version}. Read it with read_unit, ` +
      `merge your change into the new text (or diff_unit ${ref} from ${expectedVersion}), then write again with ` +
      `expected_version=${u.current_version}. Don't discard a teammate's edit.`);
  }
  const version = unwrap(res) as number;
  // Safety net: every write carries its "why", even when Claude forgets to record reasoning.
  const rec = await addRecord(ctx, "rationale", summary, reasoning?.trim() || summary, [ref]);
  return `Saved ${ref} v${version} (reasoning ${rec.ref}).`;
}

// ─────────────────────────────────────────────────────────────── records

export async function addRecord(ctx: Ctx, type: string, title: string, body: string, links: string[] = []) {
  if (!RECORD_LETTERS[type]) throw new ContexterError(`type must be one of ${RECORD_TYPES.join(", ")}`);
  const r = unwrap(await ctx.db.rpc("add_record", {
    p_workspace: ctx.ws.id, p_type: type, p_title: title, p_body: body, p_links: links, p_session: ctx.session ?? null,
  }).single()) as { type: string; number: number };
  return { ref: recordRef(r), ...r };
}

export async function getRecord(ctx: Ctx, ref: string) {
  const m = /^([DRAFQS])-?(\d+)$/i.exec(ref.trim());
  if (!m) throw new ContexterError(`"${ref}" isn't a record ref like D-0007`);
  const type = Object.entries(RECORD_LETTERS).find(([, l]) => l === m[1].toUpperCase())![0];
  const r = unwrap(await ctx.db.from("records").select("*").eq("workspace_id", ctx.ws.id)
    .eq("type", type).eq("number", Number(m[2])).maybeSingle());
  if (!r) throw new ContexterError(`No record ${ref}`);
  return r;
}

export async function updateRecord(ctx: Ctx, ref: string, status?: string, supersededBy?: string) {
  const r = await getRecord(ctx, ref);
  const patch: Record<string, unknown> = {};
  if (status) patch.status = status;
  if (supersededBy) {
    patch.superseded_by = (await getRecord(ctx, supersededBy)).id;
    patch.status = status ?? "superseded";
  }
  unwrap(await ctx.db.from("records").update(patch).eq("id", r.id));
  return `${ref} updated.`;
}

// "Why is X like this?": reasoning linked to it, plus its edit history.
export async function why(ctx: Ctx, target: string) {
  if (/^[DRAFQS]-?\d+$/i.test(target.trim())) {
    const r = await getRecord(ctx, target);
    return `${recordRef(r)} ${r.type} (${r.status}) by ${ctx.handles.get(r.author_id) ?? "?"}: ${r.title}\n\n${r.body}\n\nLinks: ${(r.links ?? []).join(", ") || "none"}`;
  }
  if (/^[a-z0-9_-]+\/[a-z0-9_.-]+$/.test(target.trim())) {
    const records = await linkedRecords(ctx, [target.trim()]);
    const history = await unitHistory(ctx, target.trim());
    const recs = records.length
      ? records.map((r) => `${recordRef(r)} ${r.type} (${r.status}) · ${ctx.handles.get(r.author_id) ?? "?"}: ${r.title}\n  ${truncate(r.body, 600)}`).join("\n")
      : "(no reasoning recorded)";
    return `Reasoning for ${target}:\n${recs}\n\nEdit history:\n${history}`;
  }
  return search(ctx, target);
}

export async function search(ctx: Ctx, query: string, limit = 15) {
  const rows = unwrap(await ctx.db.rpc("search_workspace", { p_workspace: ctx.ws.id, p_query: query, p_limit: limit })) as Any[];
  if (!rows.length) return `Nothing in ${ctx.ws.slug} matches "${query}".`;
  return rows.map((r) => `[${r.kind}] ${r.ref} — ${truncate(r.title ?? "", 80)}\n  ${truncate(String(r.snippet).replace(/<\/?b>/g, "**"), 300)}`).join("\n");
}

// ─────────────────────────────────────────────────────────────── turns & mentions

// Returns the new event's id.
export async function postEvent(ctx: Ctx, kind: string, payload: Record<string, unknown>, mentions: string[] = []): Promise<number> {
  const row = unwrap(await ctx.db.from("events").insert({
    workspace_id: ctx.ws.id, session_id: ctx.session ?? null, author_id: ctx.userId, kind, payload, mentions,
  }).select("id").single()) as { id: number };
  return row.id;
}

export async function postPrompt(ctx: Ctx, text: string): Promise<number> {
  const mentions = parseMentions(text, ctx.handles.values()).filter((h) => h !== ctx.me.handle);
  return postEvent(ctx, "prompt", { text: truncate(text, 1500) }, mentions);
}

export async function postReply(ctx: Ctx, reply: { summary: string; text?: string; files?: string[] }) {
  await postEvent(ctx, "reply", {
    summary: truncate(reply.summary, 600),
    ...(reply.text ? { text: truncate(reply.text, 1500) } : {}),
    ...(reply.files?.length ? { files: reply.files.slice(0, 30) } : {}),
  });
}

// ─────────────────────────────────────────────────────────────── work awareness

// A task is one request in one session. null hides the text (a !private turn). promptEvent is the
// prompt event posted for it, if any: only that prompt counts as "still being worked on".
export async function startTask(ctx: Ctx, task: string | null, promptEvent: number | null = null) {
  if (!ctx.session) return;
  unwrap(await ctx.db.rpc("start_task", { p_session: ctx.session, p_task: task, p_prompt_event: promptEvent }));
}

export async function finishTask(ctx: Ctx) {
  if (!ctx.session) return;
  unwrap(await ctx.db.rpc("finish_task", { p_session: ctx.session }));
}

// Earlier requests from other sessions that look like this one, as a warning block (or "").
export async function overlapWarning(ctx: Ctx, text: string): Promise<string> {
  const rows = unwrap(await ctx.db.rpc("find_overlap", {
    p_workspace: ctx.ws.id, p_text: text, p_session: ctx.session ?? null,
  })) as { author_id: string; session_id: string | null; kind: string; text: string; outcome: string | null;
           files: string[]; created_at: string; score: number; active: boolean }[];
  // One line per session: its closest match.
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const r of rows) {
    const key = r.session_id ?? `${r.author_id}:${r.created_at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const who = whoIs(ctx, r.author_id);
    const what = r.kind === "reply" ? `their Claude did: ${truncate(r.text, 200)}` : `asked "${truncate(r.text, 200)}"`;
    const state = r.active ? " (still working on it)" : r.outcome ? ` → ${truncate(r.outcome, 200)}` : "";
    const files = Array.isArray(r.files) && r.files.length ? ` [files: ${r.files.slice(0, 5).join(", ")}]` : "";
    lines.push(`• ${who} · ${ago(r.created_at)} · ${what}${state}${files}`);
  }
  if (!lines.length) return "";
  return [
    "── possible duplicate work ──",
    "This request looks like work a teammate already asked for or did:",
    ...lines,
    "Before doing it, tell the user about this overlap. If it's the same work, build on theirs (check the files, git log, " +
    "or read_unit) instead of redoing it, or suggest coordinating with a mention. If it's clearly different, carry on.",
    "──",
  ].join("\n");
}

// About to change a file (path relative to the project root): record it on this session (unless
// record is false, for private turns) and report teammates who are editing it now or changed it
// recently. warn is "" when nobody is.
export async function touchFile(ctx: Ctx, path: string, record = true): Promise<{ warn: string; activeBy: string[] }> {
  if (!ctx.session) return { warn: "", activeBy: [] };
  const rows = unwrap(await ctx.db.rpc("touch_file", { p_session: ctx.session, p_path: path, p_record: record })) as
    { author_id: string; session_id: string; task: string; touched_at: string; active: boolean }[];
  const bySession = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const prev = bySession.get(r.session_id);
    if (!prev || (r.active && !prev.active)) bySession.set(r.session_id, r);
  }
  const hits = [...bySession.values()];
  if (!hits.length) return { warn: "", activeBy: [] };
  const active = hits.filter((r) => r.active);
  const lines = hits.map((r) => r.active
    ? `• ${whoIs(ctx, r.author_id)}'s Claude is editing ${path} right now, for "${truncate(r.task, 200)}"`
    : `• ${whoIs(ctx, r.author_id)}'s Claude changed ${path} ${ago(r.touched_at)}: ${truncate(r.task, 200)}`);
  return {
    activeBy: active.map((r) => whoIs(ctx, r.author_id)),
    warn: [
      `── teammates on ${path} ──`,
      ...lines,
      "Their changes are on their machine and may not be committed or pushed yet. Before editing: check git " +
      "(git status / git log / git pull) so you build on their work instead of redoing or overwriting it." +
      (active.length ? " Someone is editing it right now: tell the user and suggest coordinating (mention) before going ahead." : ""),
      "──",
    ].join("\n"),
  };
}

export async function mention(ctx: Ctx, to: string[], text: string) {
  const known = new Set(ctx.handles.values());
  const bad = to.filter((h) => !known.has(h));
  if (bad.length) throw new ContexterError(`Unknown member(s): ${bad.join(", ")}`);
  await postEvent(ctx, "mention", { text: truncate(text, 1500) }, to);
  return `Sent to ${to.map((h) => `@${h}`).join(" ")}. Their Claude will see it on their next message.`;
}

// ─────────────────────────────────────────────────────────────── export

// Ordered markdown for a collection (or every managed collection), with an optional reasoning appendix.
export async function exportMarkdown(ctx: Ctx, opts: { collection?: string; withReasoning?: boolean } = {}) {
  const units = (await listUnits(ctx)).filter((u) => u.kind === "managed" && (!opts.collection || u.collection === opts.collection));
  const parts = [`---\ntitle: "${ctx.ws.name.replace(/"/g, '\\"')}"\n---\n`];
  for (const u of units) {
    if (!u.current_version) continue;
    const row = unwrap(await ctx.db.from("unit_versions").select("content").eq("unit_id", u.id)
      .eq("version", u.current_version).single()) as { content: string };
    parts.push(row.content.trim(), "");
  }
  if (opts.withReasoning) {
    const recs = unwrap(await ctx.db.from("records").select("*").eq("workspace_id", ctx.ws.id)
      .neq("type", "session").order("type").order("number")) as Any[];
    if (recs.length) {
      parts.push("\\newpage\n\n# Appendix: reasoning record\n");
      for (const r of recs) {
        parts.push(`## ${recordRef(r)} ${r.title}\n\n*${r.type} · ${r.status} · ${ctx.handles.get(r.author_id) ?? "?"} · ${r.created_at.slice(0, 10)}*` +
          `${r.links?.length ? ` · links: ${r.links.join(", ")}` : ""}\n\n${r.body}\n`);
      }
    }
  }
  return parts.join("\n");
}

// ─────────────────────────────────────────────────────────────── instructions

export const CHAT_RULES = `You are working in a shared contexter workspace. Several people, each with their own Claude, work in it together, and contexter makes it feel like one shared conversation.
- At the start of every reply, call contexter's sync tool with user_request set to the user's message in a sentence, except leave user_request out when the message starts with "!private". Weave anything relevant from teammates into your answer (mention who did what) and answer anything addressed to this user.
- Never redo a teammate's work: if sync reports possible duplicate work or a teammate is working on the same thing right now, tell the user before starting and build on their work or coordinate with a mention.
- Read and change shared content only through contexter tools (read_unit, write_unit, create_unit, set_status). Always pass expected_version; on a version conflict, merge, never overwrite.
- Explain the why: pass reasoning to write_unit, and call record for decisions, findings, rejected alternatives and open questions.
- Claim a unit before a long edit and release it after. Respect other people's locks.
- At the end of a reply that did real work, call post_turn with a one-to-two sentence summary so teammates see it.
- If the user starts a message with "!private", share nothing about it: call sync without user_request, and don't call post_turn or mention.
- When the user starts a long job (a training run, a stress test, a benchmark), register it with start_run (or suggest running it under \`contexter run --\`), and update_run when you learn it finished. If a teammate should follow it, pass them as watchers.
- If the user is about to stop (for example their usage limit is running out) with work unfinished, offer to hand it off: call handoff with where things stand, the next steps and the files involved.
- A "handed to you" block is work a teammate passed to this user: raise it first, and resolve_handoff (accept or decline) once the user decides.`;
