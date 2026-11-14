---
version: 1
slug: "web-index-html"
primary_target: "web/index.html"
related_targets: ["web/team/index.html","web/join/index.html"]
---

# Surface: contexter web app (dashboard, team admin, join/onboarding)

Mode: Operate (the join page is Operate too: a task, guided).
Audience/job: admins set up teams, projects, invitations and access; members accept an invitation, connect Claude, watch the live feed.
Constraints: static HTML + ES modules, no build step, light and dark, product name may change (one place).
Chosen: the category standard played straight (the user's door), bar set by Linear, Notion/Slack team admin and Vercel.
Unresolved: product name and logo; real illustrations/screenshots.

## Direction contract

THESIS: A calm, dense, trustworthy team-admin product that is still friendly. It refuses the one-long-page admin dump: one shared app shell, tabs for People / Projects / Invitations / Settings, and an onboarding page that feels like a checklist you can finish.
OWN-WORLD: Cool-neutral surfaces tinted toward indigo (OKLCH), one indigo accent for primary actions, selection and focus; semantic green/amber/red only for state; Geist Sans and Geist Mono (tabular figures for counts and codes); hairline borders, soft 1-2px shadows, 8px radii; coloured initial avatars derived from names; friendly inline-SVG empty states. Light and dark share the same hues.
STORY: An admin creates a team, invites five people in a minute, sees who has joined and what each can open. An invitee lands, sees they are in, and finishes four checklist steps with copy buttons until it says "Connected". Members glance at a live feed that feels alive.
FIRST VIEWPORT: Left sidebar 240px (wordmark, team switcher, Feed / People / Projects / Invitations / Settings, theme toggle and user at the bottom); page header with title, one-line subtitle and the primary action top right; below it a row of four stat tiles, then the main work area. On /join: a centred 720px column with a progress header ("Step 1 of 4"), a welcome card, then the numbered checklist.
FORM: the category standard (canon), position: user's door, seed: none (user took the standing exit).
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
