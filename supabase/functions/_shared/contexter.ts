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
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
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

export async function presence(ctx: Ctx): Promise<string[]> {
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const [sessions, units] = await Promise.all([
    ctx.db.from("sessions").select("id, user_id, client, title, last_seen_at, focus_unit")
      .eq("workspace_id", ctx.ws.id).is("ended_at", null).gt("last_seen_at", since),
    ctx.db.from("units").select("collection, key, lock_holder, lock_expires_at")
      .eq("workspace_id", ctx.ws.id).not("lock_holder", "is", null).gt("lock_expires_at", new Date().toISOString()),
  ]);
  const lines: string[] = [];
  for (const s of unwrap(sessions) as Any[]) {
    if (s.id === ctx.session) continue;
    const who = s.user_id === ctx.userId ? "you (another session)" : ctx.handles.get(s.user_id) ?? "someone";
    lines.push(`${who} is active in ${s.client}${s.title ? ` ("${truncate(s.title, 60)}")` : ""}, seen ${ago(s.last_seen_at)}`);
  }
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

export async function postEvent(ctx: Ctx, kind: string, payload: Record<string, unknown>, mentions: string[] = []) {
  unwrap(await ctx.db.from("events").insert({
    workspace_id: ctx.ws.id, session_id: ctx.session ?? null, author_id: ctx.userId, kind, payload, mentions,
  }));
}

export async function postPrompt(ctx: Ctx, text: string) {
  const mentions = parseMentions(text, ctx.handles.values()).filter((h) => h !== ctx.me.handle);
  await postEvent(ctx, "prompt", { text: truncate(text, 1500) }, mentions);
}

export async function postReply(ctx: Ctx, reply: { summary: string; text?: string; files?: string[] }) {
  await postEvent(ctx, "reply", {
    summary: truncate(reply.summary, 600),
    ...(reply.text ? { text: truncate(reply.text, 1500) } : {}),
    ...(reply.files?.length ? { files: reply.files.slice(0, 30) } : {}),
  });
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
- At the start of every reply, call contexter's sync tool. Weave anything relevant from teammates into your answer (mention who did what) and answer anything addressed to this user.
- Read and change shared content only through contexter tools (read_unit, write_unit, create_unit, set_status). Always pass expected_version; on a version conflict, merge, never overwrite.
- Explain the why: pass reasoning to write_unit, and call record for decisions, findings, rejected alternatives and open questions.
- Claim a unit before a long edit and release it after. Respect other people's locks.
- At the end of a reply that did real work, call post_turn with a one-to-two sentence summary so teammates see it.
- If the user starts a message with "!private", don't post that turn.`;
