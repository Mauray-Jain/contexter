# contexter

**One shared conversation for a team where everyone uses Claude on their own account.**

Each person keeps their own Claude, but all of them work in one shared *workspace*: the
content (a paper, specs, a book…), the reasoning behind it, and a live team feed. Before each
of your messages, your Claude learns what your teammates asked, what their Claudes changed and
why. It feels like everyone is in the same chat.

```
── team feed since your last message (retrieval-paper) ──
• priya · 4m ago · asked: "Can you check the results table against the new runs? @mauray"  ← mentions you
• priya · 3m ago · → their Claude: Updated Table 2 with the new re-ranker runs; latency still open (Q-0001).
• sam · just now · is editing sections/results
──
```

It works in **Claude Code** (CLI and the desktop app's Code tab) and **Claude chat** (desktop,
web, mobile), all through one remote MCP server on Supabase. See [PLAN.md](PLAN.md) for the design.

## What you get

- **A live team feed.** Prompts, reply summaries, edits, decisions, locks and @mentions show up in
  everyone's Claude. In Claude Code this happens automatically before every message (hooks).
  In chat, Claude calls `sync` first, and every contexter tool reply carries the latest activity.
- **Shared content in units** (`sections/method`, `chapters/chapter-03`, …). Every unit is
  versioned, and a write is refused if a teammate wrote first, so Claude merges instead of
  overwriting. Locks let someone hold a unit during a long edit.
- **Shared reasoning.** Decisions, rationales, rejected alternatives, findings and open questions,
  numbered (D-0007, Q-0002) and linked to the content they explain. Every write records its "why".
  `why sections/method` answers from the record.
- **Team memory.** A running summary that any member's Claude updates when the feed gets long,
  so a fresh session starts with the whole story so far.
- **Presence** ("priya is active in claude-chat"), **@mentions**, and **`!private`** messages
  that stay out of the feed.
- **Templates:** `research-paper`, `software`, `book`, `spec`, `knowledge-base`, `blank`.
- **Export** through pandoc (md, pdf, docx, html, tex, epub) with citations from the workspace
  bibliography and an optional reasoning appendix. Also a **git mirror** for backups.
- **Dashboard:** a web page with the live feed, who's active, units, locks, questions and decisions.

## Setting it up for your team

One person sets up the backend once; everyone else just connects.

### 1. Backend (once)

1. Create a [Supabase](https://supabase.com) project. In the dashboard:
   - **Authentication → OAuth Server:** enable it and turn on dynamic client registration.
     Set the authorization path to `/oauth/consent`.
   - **Project Settings → JWT Keys:** switch to an asymmetric signing key (ES256 or RS256).
     The MCP server only accepts asymmetric tokens.
   - **Authentication → URL Configuration:** set the Site URL to where the web pages live
     (step 2). Add `http://127.0.0.1:54545/callback` to the redirect URLs (CLI sign-in).
   - **Authentication → Providers → GitHub:** enable it with a GitHub OAuth app (optional; email
     codes work without it). For email codes, put `{{ .Token }}` in the *Magic link* and
     *Confirm signup* templates (see `supabase/templates/`).
2. Push the schema and deploy the MCP server:
   ```bash
   npx supabase link --project-ref <ref>
   ```
   ```bash
   npx supabase db push
   ```
   ```bash
   npx supabase functions deploy mcp --no-verify-jwt
   ```
3. Publish the web pages (consent screen and dashboard). With GitHub Pages: set repository
   variables `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`, set Pages to "GitHub Actions", and
   push. The `pages` workflow deploys `web/`. Any static host works; it just needs `config.js`.

The publishable key is safe to share. **Never share the secret/service-role key.**

### 2. Each member

```bash
git clone https://github.com/Mauray-Jain/contexter && cd contexter && npm install && npm run build
```

```bash
node packages/cli/dist/contexter.mjs setup --url https://<ref>.supabase.co --key <publishable-key>
```

```bash
node packages/cli/dist/contexter.mjs login
```

(Alias it: `alias contexter="node $PWD/packages/cli/dist/contexter.mjs"`.)

One person creates the workspace and invites the others:

```bash
contexter init retrieval-paper --handle mauray --template research-paper
```

```bash
contexter invite --uses 2
```

The others join:

```bash
contexter join <code> --handle priya
```

### 3. Connect Claude

**Claude Code / the desktop Code tab** (full automatic sync), from your project folder:

```bash
contexter install code --workspace retrieval-paper
```

It adds the hooks and the skill, then prints a `claude mcp add …` command to run once.

**Claude chat** (desktop, web, mobile):

```bash
contexter install chat
```

It packages the skill and prints the steps: add the MCP URL as a custom connector, sign in and
approve, then upload the skill. Start any chat with "catch me up".

## Everyday use

Just talk to Claude. Useful phrases and commands:

| You | What happens |
|---|---|
| "catch me up" | `resume`: overview, team memory and everything since |
| "why is the method like this?" | `why sections/method` from decisions, rationales and history |
| "@priya can you check Table 2?" | Priya's Claude raises it first on her next message |
| `!private …` | That turn isn't shared |
| `contexter watch --notify` | Live feed in a terminal, with desktop notifications |
| `contexter run -t "stress test" -w krish -- ./stress.sh` | Run a long job where the team can see it: progress, log tail and exit code, heartbeat every minute; krish hears when it ends |
| "let krish watch run 12" | `watch_run`: krish's Claude tells krish now and when it ends |
| "my limit is running out, hand this to krish" | `handoff`: krish's Claude brings it up first; accepting moves your locks and runs to krish |
| `contexter export --format pdf --with-reasoning` | The paper, with a reasoning appendix |
| `contexter mirror ../paper-backup` | Plain-file git backup of everything |

Other commands: `runs [n] [--watch]`, `handoffs [n] [--accept|--decline]`, `status`, `feed`, `memory`, `search`, `why`, `workspaces`, `use`, `templates`, `uninstall`.

## Development

Needs Docker, Node 20+, and pandoc + zip for the CLI tests.

```bash
npm install
```

```bash
npm run db:keys
```

```bash
npm run db:start
```

```bash
npm test
```

`npm test` builds the CLI and runs every suite against the local stack: database (pgTAP: access
rules, locks, versions, feed, memory, search), MCP server, the full OAuth connector flow, Claude
Code hooks, CLI features and an end-to-end CLI run. The local stack uses ports **553xx** (API
`55321`, mail viewer `55324`), so it can run next to other Supabase projects.

`npm run web` serves the consent page and dashboard at http://127.0.0.1:3000.
`npm run seed -- you@example.com` fills a demo workspace (sign in at the dashboard with that
email; the code arrives in the mail viewer).

```
supabase/migrations/        schema, RLS, RPCs (sessions, feed, locks, versions, memory, search)
supabase/functions/mcp/     remote MCP server (Edge Function, OAuth via Supabase Auth)
supabase/functions/_shared/ core logic shared by the MCP server and the CLI
packages/cli/               contexter CLI and Claude Code hooks
skill/contexter/            the Claude skill (rules for working in a workspace)
web/                        consent page + live dashboard (static)
scripts/                    build, local web server, demo seed, test suites
```
