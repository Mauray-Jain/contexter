# contexter

Shared context and reasoning for teams who each use Claude on their own account.
The goal is that everyone feels like they're in one chat. See [PLAN.md](PLAN.md) for the full design.

**Status: Phase 0 done.** Supabase schema with access rules, locking and versioning; a CLI to
sign in, create/join workspaces, invite teammates, and read the team feed. The MCP server
(Phase 1) and Claude hooks (Phase 2) come next.

## Layout

```
supabase/
  migrations/…_core_schema.sql   tables, RLS, RPCs (create/join workspace, claim/write unit, records, feed)
  tests/database/core.test.sql   pgTAP tests for access rules, locks, versions, feed
  templates/                     sign-in email templates (6-digit code)
packages/cli/                    the `contexter` CLI (TypeScript, run with tsx)
scripts/e2e-local.sh             end-to-end test: five simulated members against the local stack
```

## Local development

Needs Docker and Node.

```bash
npm install
```

```bash
npm run db:start
```

The local stack uses ports **553xx** (API on `55321`, mail viewer on `55324`), so it can run
next to other local Supabase projects.

```bash
npm run db:test
```

```bash
npm run test:e2e
```

Try the CLI as yourself against the local stack:

```bash
npm run ctx -- setup --url http://127.0.0.1:55321 --key "$(npx supabase status -o env | sed -n 's/^PUBLISHABLE_KEY="\(.*\)"/\1/p')"
```

```bash
npm run ctx -- login --email you@example.com
```

The code arrives in the local mail viewer at http://127.0.0.1:55324.

## CLI

| Command | What it does |
|---|---|
| `setup --url --key` | Point this machine at the team's Supabase project |
| `login [--email addr]` | Sign in with GitHub (default) or an emailed code |
| `init <slug> --handle you [--template research-paper]` | Create a workspace (you become owner) |
| `invite [--role editor\|viewer] [--uses n] [--days n]` | Make an invite code (owners only) |
| `join <code> --handle you` | Join a workspace |
| `workspaces` / `use <slug>` | List / switch workspaces |
| `status` | Members, units, versions, locks |
| `feed` | Teammates' activity since you last looked |
| `whoami` / `logout` | |

Local state lives in `~/.config/contexter/` (override with `CONTEXTER_HOME`), with files only
your user can read.

## Hosted setup (for the team)

1. Create a Supabase project, then link it and push the schema:
   ```bash
   npx supabase link --project-ref <ref>
   ```
   ```bash
   npx supabase db push
   ```
2. **Auth → Providers → GitHub:** enable it with a GitHub OAuth app. Then
   **Auth → URL Configuration:** add `http://127.0.0.1:54545/callback` to the redirect URLs.
3. **Auth → Email templates:** for email-code sign-in, put `{{ .Token }}` in the *Magic link* and
   *Confirm signup* templates (copy `supabase/templates/magic_link.html`).
4. Each member runs `contexter setup --url <project-url> --key <publishable-key>`, then `contexter login`.
5. One person runs `contexter init … --template research-paper` and `contexter invite --uses 2`.
   The others run `contexter join <code> --handle <name>`.

The publishable key is safe to share. **Never share the service-role/secret key.**
