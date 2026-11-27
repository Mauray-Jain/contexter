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
- **Teams:** people, projects and per-project access in one place. Admins invite by email from
  the web or the CLI, pick each person's team role and project access, and set what new members
  get by default. Invitees follow the emailed link to a join page that walks them through
  connecting Claude.

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
     *Confirm signup* templates, and use `supabase/templates/invite.html` for *Invite user*.
     Add `<site-url>/join` to the redirect URLs too (invitation links land there).
   - **Authentication → SMTP:** set up a custom SMTP server. The built-in mailer only sends to
     your own team's addresses and is heavily rate-limited, so invitations to anyone else fail.
2. Push the schema and deploy the MCP server and the invitation mailer:
   ```bash
   npx supabase link --project-ref <ref>
   ```
   ```bash
   npx supabase db push
   ```
   ```bash
   npx supabase functions deploy mcp --no-verify-jwt
   ```
   ```bash
   npx supabase functions deploy invite-members --no-verify-jwt
   ```
   ```bash
   npx supabase secrets set CONTEXTER_WEB_URL=https://<where-the-web-pages-live>
   ```
   `CONTEXTER_WEB_URL` is where invitation emails link to (`<url>/join`).
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

One person creates a team and a project (a *workspace* in the CLI) in it. This works from the
web app too (sign in, then **Projects → New project**):

```bash
contexter team create lab --name "Retrieval lab"
```

```bash
contexter init retrieval-paper --team lab --template research-paper
```

Then invites everyone by email, with **Invite people** on the web or with:

```bash
contexter invite priya@lab.org sam@lab.org
```

By default an invitation gives access to the active project as an editor. `-p` picks other
projects, `--role viewer` gives read-only access, and `--admin` makes them team admins.
`contexter team default all` gives every new member every project.

Each invitee follows the link in the email to the join page, which shows the commands to connect
Claude. After signing in with the CLI, accepting is one command:

```bash
contexter join
```

Managing the team later: `contexter team` (projects, people, access and pending invitations),
`team role <email> <owner|admin|member>`, `team remove <email>`, `team invites`,
`team revoke <email>`, and `contexter transfer <email>` to hand a project to someone else.

Without a team, `contexter init <slug>` makes a standalone project, and `contexter invite` with
no emails prints an invite code (`--uses`, `--days`) that others redeem with `contexter join <code>`.

### 3. Connect Claude

**Claude Code / the desktop Code tab** (full automatic sync), from your project folder:

```bash
contexter install code --workspace retrieval-paper
```

It adds the hooks, the skill and the MCP server (`.mcp.json`), and approves the server in your
git-ignored `.claude/settings.local.json`, since the Code tab never asks. Start a new session
afterwards. With `--scope user` it prints a `claude mcp add …` command to run once instead.

Claude Code sessions only join a workspace from a folder linked to it (a `.contexter.json`), so
each project sees only its own team's tasks. With `--scope user` (hooks for every project), link
each project folder once; other folders stay out of contexter:

```bash
contexter link retrieval-paper
```

**Claude chat** (desktop, web, mobile):

```bash
contexter install chat
```

It packages the skill and prints the steps: add the MCP URL as a custom connector, sign in and
approve, then upload the skill. Start any chat with "catch me up".

### 4. Updating

After a change is merged to `main`, the backend comes first, then every member.

**Backend** (the person who set it up), from an up-to-date `main`. Redeploy every function that
changed (`mcp`, `invite-members`). Deploying from an older branch
would roll the MCP server back.

```bash
git checkout main && git pull
```

```bash
npx supabase db push --dry-run
```

Check it lists only the new migrations, then apply them and redeploy the MCP server:

```bash
npx supabase db push
```

```bash
npx supabase functions deploy mcp --no-verify-jwt
```

**Each member**, on every machine:

```bash
cd <your contexter clone> && git checkout main && git pull && npm install && npm run build
```

Then, in each project folder connected to the workspace:

```bash
contexter install code --workspace <slug>
```

The hooks call the built CLI, so open Claude Code sessions pick up the new build on their next
message. Re-running `install code` adds any hooks a new version needs and refreshes the
contexter entry in `.mcp.json`, leaving your other servers alone. Claude chat needs nothing unless a release says to upload the skill again.

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
| `contexter run -t "family" -- modal run --detach bl_modal.py --task family` | Also records the Modal app id and profile, so if your laptop closes the job can be handed off and watched from a teammate's machine |
| `contexter modal track ap-… -t "sweep"` | This machine watches a detached Modal job started some other way |
| "let krish watch run 12" | `watch_run`: krish's Claude tells krish now and when it ends |
| "my limit is running out, hand this to krish" | `handoff`: krish's Claude brings it up first; accepting moves your locks and runs to krish |
| `contexter export --format pdf --with-reasoning` | The paper, with a reasoning appendix |
| `contexter mirror ../paper-backup` | Plain-file git backup of everything |

Other commands: `team …`, `transfer`, `link`/`unlink`, `runs [n] [--watch]`, `handoffs [n] [--accept|--decline]`, `status`, `feed`, `memory`, `search`, `why`, `workspaces`, `use`, `templates`, `uninstall`.

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

`npm run web` serves the web app (sign-in, team admin, join page, consent page and dashboard) at
http://127.0.0.1:3000.
`npm run seed -- you@example.com` fills a demo workspace (sign in at the dashboard with that
email; the code arrives in the mail viewer).

```
supabase/migrations/        schema, RLS, RPCs (sessions, feed, locks, versions, memory, search)
supabase/functions/mcp/     remote MCP server (Edge Function, OAuth via Supabase Auth)
supabase/functions/invite-members/  sends team invitation emails
supabase/functions/_shared/ core logic shared by the MCP server and the CLI
packages/cli/               contexter CLI and Claude Code hooks
skill/contexter/            the Claude skill (rules for working in a workspace)
web/                        web app: team admin, join, consent page, live dashboard (static)
scripts/                    build, local web server, demo seed, test suites
```
