# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Existing: static HTML, ES modules and one shared stylesheet in `web/`, no build step, served as static files (GitHub Pages in CI, `npm run web` locally). Supabase supplies auth, Postgres and Edge Functions. Keep it dependency-light; the only runtime import is `@supabase/supabase-js` from a CDN.

## Users

Small teams in which every person uses Claude on their own account: research groups writing a paper together, and engineering teams coordinating Claude Code on a codebase. Researchers and engineers are equal audiences. Two roles meet this UI: the **admin** (creates the team, adds projects, invites people by email, chooses project access) and the **member** (accepts an invitation, connects Claude, then glances at the live team feed to see what teammates and their Claudes did).

## Product Purpose

contexter makes a team's separate Claude accounts feel like one shared conversation: a live feed of what everyone asked and changed, versioned shared content, and the reasoning behind decisions. The web UI is where a team is set up (teams, projects, email invitations, per-project access), where a new member gets connected in a few minutes, and where anyone can watch the team's activity live. Success is an admin inviting a whole team in a minute and every invitee reaching "my Claude is connected" without help.

## Positioning

Other tools share documents or chats. contexter shares the work and the reasoning across people's separate Claudes, and shows it live. It is built for teams that already use Claude, not a replacement for it.

## Operating Context

Used on laptops beside a terminal and a Claude window, often left open as a live feed. Invitees arrive from an emailed link on any device. Light and dark are both needed. Hosted as one site serving many teams; self-hosting by third parties is a secondary path.

## Capabilities and Constraints

- Admin: create team, see projects and people with per-project access, invite by email with team role and project grants, resend/revoke invitations, change roles, remove people, set a default for new members.
- Member: accept invitation, connect Claude Code or Claude chat via copied commands, see their projects, open the live dashboard.
- Live dashboard: team feed (realtime), who is active now, units and their status/locks, open questions, decisions, team memory.
- Projects are created from the CLI (templates); the web shows the command.
- Terminology: team, project (a workspace in the code), member, invitation, feed, unit, decision, team memory.
- Undecided: the product name ("contexter" may change), so keep the name in one place; no logo yet.

## Brand Commitments

None binding. The name may change. The tone requested is corporate, professional and also fun. Standing preference (chosen by the user): the familiar category standard executed at full fidelity, with craft level set by Linear, Notion/Slack team admin and Vercel.

## Evidence on Hand

Real data only: the local and live workspaces. No testimonials, customer logos, metrics or screenshots exist; do not fabricate any.

## Product Principles

- A first-time invitee should never wonder what to do next.
- Show the team's activity as it happens; the feed is the heart of the product.
- Access is explicit: who can do what, and why, is always visible.
- Say what happened and what to do next in plain words, especially on errors.

## Accessibility & Inclusion

Keyboard-operable, visible focus, sufficient contrast in both themes, and respect for reduced-motion preferences.
