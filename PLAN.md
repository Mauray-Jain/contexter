# contexter: one shared conversation across separate Claude accounts

**End goal:** a team of people, each using Claude on their *own* account, should feel
like they're all in **one chat**. Whenever you send a message, your Claude already
knows what your teammates just asked, what their Claudes did, what changed, and why.
The project content (a paper, code, specs…) and the reasoning behind it stay in sync live.

Backend: **Supabase** (Postgres + Auth + Realtime + Storage + Edge Functions).
Clients: **Claude Code** (CLI and the desktop app's Code tab) and **Claude chat**
(desktop, web and mobile), all served by **one remote MCP server**, added as a custom connector.
Project-agnostic. A research paper is just one template.

---

## 1. How the illusion works

Real shared chat is impossible: each account has its own private context. contexter
fakes it by keeping a **shared team feed** and putting the relevant slice of it into
every member's context **before every message**.

```
 mauray's Claude ─┐                               ┌─► friend1's Claude
                  │ post turn         new events  │   (before next prompt:
 friend1's Claude ┼──────────► Supabase ──────────┤    "while you were away…")
                  │           events + units      │
 friend2's Claude ─┘           records + memory    └─► friend2's Claude
```

Each turn, for each member:
1. **Before the prompt reaches Claude:** fetch feed events since this member's cursor
   and inject them as a compact block (who asked what, what their Claude changed,
   decisions made, who is working on what right now).
2. **Claude answers** with full awareness, and can call tools to read anything in more detail.
3. **After the reply:** post this turn to the feed (prompt, reply summary, edits,
   reasoning), so teammates' Claudes see it on their next message.

What makes it feel like one chat:
- **Per-message updates**, not just at session start.
- **Shared memory**: a rolling team summary, compacted over time, so a new session
  starts with the whole story so far, not an empty context.
- **Presence**: "friend2 is editing sections/results right now (started 4 min ago)".
- **Addressing**: `@friend1` in a prompt flags the event for them. Their Claude brings it
  up first on their next message.
- **One version of the truth**: edits go through the same database with real locks and
  version checks, so two Claudes can't silently overwrite each other.

## 2. Client capabilities: where the illusion is full vs. partial

| Capability | Claude Code (CLI / desktop **Code tab**) | Claude **chat** (desktop / web / mobile) |
|---|---|---|
| Remote MCP server (custom connector) | yes (`claude mcp add --transport http`) | yes (Settings → Connectors) |
| Skills | yes | yes (uploaded custom skill) |
| `SessionStart` hook (load memory) | yes | no |
| `UserPromptSubmit` hook (**inject feed before every message**) | yes | no |
| `Stop` hook (**post turn after every reply**) | yes | no |
| Transcript access | yes | no |

- **Claude Code / desktop Code tab: full illusion.** Hooks make it automatic: nobody
  has to remember anything.
- **Chat: partial illusion.** No hooks, so Claude must *choose* to call
  `sync()` at the start of each reply and `post_turn()` at the end. Four layers make
  that as likely as possible:
  1. **Remote connector** (transport): the same contexter tools in desktop, web and mobile chat,
     with no local install.
  2. **contexter skill** (behaviour): rules Claude loads whenever the workspace comes up:
     sync first, write only through tools, record reasoning, post at the end.
  3. **Sync data included in every tool result**: *any* contexter tool call also returns the
     new feed events, so reading or writing anything syncs too.
  4. **Tool descriptions** that repeat "call `sync` first in every reply".
  Usually reliable, never guaranteed. MCP can't push into a chat on its own.
- **Recommendation for the team:** use the desktop app's **Code tab** (it's Claude Code,
  so hooks work) even for non-code work like writing the paper. Plain chat stays supported as a fallback.

## 3. Core concepts

| Concept | Meaning |
|---|---|
| **Workspace** | One shared project, e.g. "Retrieval paper". Rows in Supabase, scoped by membership. |
| **Member** | A person, signed in with Supabase Auth. Separate from their Claude account. |
| **Session** | One Claude conversation of one member. Has client type, focus, last-seen time (drives presence). |
| **Event** | One entry in the shared feed: `prompt`, `reply`, `edit`, `record`, `status`, `presence`, `mention`, `compaction`. |
| **Unit** | An addressable piece of content (section, chapter, spec, module). Versioned. |
| **Record** | Reasoning: `decision`, `rationale`, `alternative`, `finding`, `question`. Links to units/events. |
| **Shared memory** | A rolling, compacted summary of the feed: what's been done, current state, open questions. |
| **Template** | Preset bundle: collections, record types, validators, Claude instructions, exporter. |

## 4. Supabase design

### 4.1 Tables
```
workspaces     (id, name, template, manifest jsonb, created_by, created_at)
members        (workspace_id, user_id, handle, role)                        -- owner | editor | viewer
sessions       (id, workspace_id, member_id, client, title, focus_unit,
                started_at, last_seen_at, ended_at)
events         (id bigserial, workspace_id, session_id, member_id,
                kind, payload jsonb, mentions text[], private bool, created_at)
cursors        (workspace_id, member_id, last_event_id)                     -- "seen up to"
units          (id, workspace_id, collection, key, status, owner_id,
                current_version, lock_holder, lock_session, lock_expires_at)
unit_versions  (unit_id, version, content, author_id, event_id, summary, created_at)
records        (id, workspace_id, type, title, body, links jsonb,
                status, superseded_by, author_id, event_id, created_at)
shared_memory  (workspace_id, version, summary, covers_up_to_event, created_by, created_at)
```
- **Storage bucket** `assets/` for figures, PDFs, datasets.
- **Full-text search** (`tsvector`) on unit content, records and event payloads. `pgvector`
  can be added later.

### 4.2 Security
- **Row Level Security** on every table: you can only access rows of workspaces you're a member of.
- Members sign in once per machine through the CLI (magic link or GitHub OAuth). The
  refresh token is stored locally in the OS keychain, never in the repo or config files.
- Only the public anon key ships with the client. The service role key is never used.

### 4.3 Postgres functions (atomic operations, called via RPC)
- `claim_unit(unit, ttl)`: real lock, so two members' Claudes can't both win.
- `write_unit(unit, content, expected_version, summary)`: optimistic concurrency. If someone
  else wrote first, return their version, and Claude merges instead of overwriting.
- `post_turn(session, prompt, reply_summary, edits[], records[])`: one transaction that
  writes events, versions and records.
- `feed_since(cursor, budget)`: returns events plus a ready-made digest, and advances the cursor.

### 4.4 Realtime
Subscriptions on `events`, `units` (locks/status) and `sessions` (presence).
- The remote MCP server is stateless (Edge Function), so it queries Postgres directly. That's
  fast, because it runs next to the database.
- The local **hook CLI** (Claude Code only) can keep a small realtime-fed cache so the
  per-prompt hook stays fast.
- The **team dashboard** (§7.5) subscribes for live presence and feed.
- Optional later: a desktop notification ("friend1's Claude just rewrote §method").

## 5. What gets shared per turn (the feed format)

Posted by the `Stop` hook (Code) or `post_turn()` (chat):

| Part | Default | Notes |
|---|---|---|
| Your prompt | verbatim (truncated at ~1k chars) | |
| Claude's reply | final text, truncated, plus a one-line summary | no model call needed: taken from the transcript |
| Edits | unit + version + diff stats | full diff available via tool |
| Reasoning | records Claude created this turn | the "why" |
| Raw thinking | **off** | opt-in per workspace; best-effort (often summarized or absent) |

**Privacy:** starting a prompt with `!private` (or toggling `/ctx private`) skips posting
that turn. Edits to shared units are still recorded, since others depend on them.

What gets injected before each message (budget ~1.5k tokens, overflow → "N more, call `team_feed()`"):
```
── team feed since your last message ──
• friend1 · 3m ago · asked: "tighten the ablation paragraph in method"
  → their Claude rewrote sections/method (v11→v12), decided D-0009:
    drop the BM25 baseline (redundant with dense-only ablation; see F-0014)
• friend2 · now · editing sections/results (locked until 15:40)
• @you from friend2: "can you check whether Table 2 still matches the new numbers?"
──────────────────────────────────────
```

## 6. Shared memory and compaction
- At **session start**, Claude gets: workspace overview, the latest `shared_memory` summary,
  plus events since that summary was made.
- When the uncompacted events go over a threshold (e.g. 40 events or ~8k tokens), the next
  member's Claude gets an injected request to **compact**. It calls
  `compact_memory(new_summary)` with an updated summary, which becomes a new `shared_memory` row.
- This uses whichever member's Claude happens to be active, so there's **no separate API key and no server-side
  model calls**. Older summaries are kept, so you can always look back.

## 7. Components

### 7.1 `contexter` CLI
`login`, `init [--template]`, `join <invite-code>`, `invite <email>`, `install --code|--skill`,
`status`, `feed`, `export`, `mirror --git` (optional read-only backup of content and records to a git repo).

### 7.2 `contexter-mcp`: one remote server for every client
- Runs as a **Supabase Edge Function** speaking MCP over **Streamable HTTP** (stateless mode).
- **Auth:** MCP's OAuth flow, backed by Supabase Auth with GitHub sign-in. Use Supabase's
  OAuth 2.1 server support if available on the project's plan/version (verify), otherwise a thin
  OAuth shim Edge Function that wraps Supabase sessions. Every request runs as the signed-in
  member, so RLS still applies.
- **Install:** chat: Settings → Connectors → add custom connector with the URL. Code:
  `claude mcp add --transport http contexter <url>`. Same tools everywhere. Custom
  connectors may depend on your Claude plan (verify for all three accounts).
- **Every tool response** ends with a `feed_delta` block (new events since cursor, capped), so any
  call keeps Claude in sync.

| Tool | Purpose |
|---|---|
| `sync()` | New feed events + presence (chat calls this every turn) |
| `post_turn(summary, edits?, records?)` | Chat's end-of-turn post (hooks do it automatically in Code) |
| `team_feed(since?, member?, unit?)` | Browse the feed in detail |
| `get_overview()` | Units, statuses, owners, locks, active sessions, open questions |
| `read_unit(ref, version?)` / `diff_unit(ref, from, to)` | Content and history |
| `claim_unit` / `release_unit` | Locks |
| `write_unit(ref, content, expected_version, summary, reasoning?)` | Versioned write; auto-creates a rationale record |
| `record(type, title, body, links)` | Reasoning |
| `why(ref_or_query)` | Explain current state from records and events |
| `mention(member, text)` | Message a teammate's Claude |
| `compact_memory(summary)` | Update shared memory when asked |
| `search(query)` | Across units, records, feed |
| `use_workspace(name)` | Switch workspace |

Prompts: `resume`, `checkpoint`, `review(ref)`, `onboard`.

### 7.3 Claude Code hooks (installed by `contexter install --code`)
| Hook | Action |
|---|---|
| `SessionStart` | Register session, inject overview + shared memory + recent events |
| `UserPromptSubmit` | Inject feed delta since cursor, plus a compaction request if needed. Handles `!private` |
| `Stop` | Parse transcript for the last turn and call `post_turn` |
| `SessionEnd` | Mark session ended, release this session's locks |

Hooks run the local `contexter` CLI, which calls Supabase directly (using the member's stored
session) with an optional realtime-fed local cache. Target: under 150ms added per prompt.

### 7.4 Claude chat (desktop, web, mobile)
- **Remote connector** (§7.2): no local install; works on every device.
- **contexter skill** (`contexter install --skill` builds a zip to upload in Claude settings):
  `SKILL.md` with the per-turn rules, the feed format, how to resolve version conflicts, and when
  to compact memory. The same skill is installed in Claude Code too, so behaviour matches everywhere.
- **Project instructions** (optional, one line): "This project is contexter workspace `<name>`."
  That helps the skill trigger.
- **Safety net:** any write tool also posts an `edit` event and a rationale record, so even if
  Claude forgets `post_turn`, teammates still see what changed and why.
- **Manual fallbacks:** the `resume` / `checkpoint` prompts and attachable resources
  (`team feed`, `unit/{ref}`) in the connector menu.

### 7.5 Team dashboard
A small live page (Supabase Realtime) showing the feed, presence, unit status, locks and open
questions. It stays open beside any chat, so people see each other's activity even when Claude
isn't syncing. Can be a Claude artifact if it can reach Supabase, otherwise a static page on
Supabase/any host.

## 8. Templates (generic layer)
A template defines collections, unit statuses, record types, validators, Claude instructions and an exporter.
Shipped first: `research-paper` (ordered sections, `refs` collection, figures, pandoc → PDF with
optional reasoning appendix) and `blank`. Later: `software` (specs managed, code linked by path),
`book`, `spec`, `knowledge-base`. A template is stored in `workspaces.manifest`, so every
member's Claude sees the same structure and rules.

## 9. Phases

| Phase | Deliverable | Done when |
|---|---|---|
| 0. Backend ✅ | Supabase project, schema, RLS, RPC functions, auth; CLI `login/init/invite/join` | Three accounts join one workspace; RLS blocks outsiders |
| 1. Remote MCP server ✅ | Edge Function, MCP OAuth via Supabase Auth, all tools, `feed_delta` on every response | Connector added in claude.ai *and* Claude Code; A writes a unit, B's `sync()` shows it with reasoning |
| 2. Code hooks ✅ | SessionStart / UserPromptSubmit / Stop / SessionEnd via local CLI | **The illusion:** A asks something in the Code tab; B's *next message* already knows about it |
| 3. Chat ✅ | contexter skill, write safety net, prompts/resources, dashboard | A member on web or mobile chat and a Code member see each other's turns |
| 4. Memory + presence ✅ | compaction flow, presence, `@mentions`, `!private` | A fresh session a week later starts with an accurate team summary |
| 5. Templates + export ✅ | `research-paper`, `blank`, pandoc export, git mirror | Your paper exports to PDF from the workspace |
| 6. Polish (mostly ✅: notifications, dashboard, full-text search, all templates; pgvector not done) | notifications, web viewer of feed/units, pgvector search, more templates | As needed |

## 10. Open decisions
1. **Supabase hosting:** hosted free tier (recommended to start; 3 users is tiny) or self-hosted.
2. **Sign-in:** GitHub OAuth (recommended, you all have GitHub) or email magic link.
3. **Reply sharing depth:** truncated final reply + summary (recommended), full reply, or summary only.
4. **Language:** TypeScript (recommended now: Supabase Edge Functions run Deno/TypeScript,
   `supabase-js` + Realtime are first-class, and the MCP TypeScript SDK fits) or Python.

## 11. Risks
- **Context budget:** a busy feed could crowd out the actual work. Mitigation: digest budget,
  compaction, details only on demand.
- **Chat compliance:** without hooks it relies on Claude following the skill. Mitigation: sync data in every
  tool result, the write safety net, the dashboard, and recommending the Code tab.
- **Connector availability / OAuth:** custom connectors may depend on plan, and MCP OAuth on Edge
  Functions is the most fiddly part. Mitigation: build and test the auth flow first in Phase 1,
  with a fallback of a local stdio wrapper that forwards to the same HTTP endpoint.
- **Simultaneous edits:** two people prompting at the same moment. Mitigation: DB locks + `expected_version`.
- **Oversharing:** everything you type is visible to teammates by default. Mitigation: `!private`
  and clear onboarding.
- **Hook latency:** network calls on every prompt. Mitigation: the local realtime cache.
