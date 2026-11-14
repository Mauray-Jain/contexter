# Design: contexter web app

**Idea: threads.** contexter turns many separate Claudes into one conversation. Every teammate has a colour, and their threads braid into one line. That is the single memorable element: the landing weave flowing into the product window, the join page weaving the newcomer's own thread in, and each person's thread running through their rows in the feed. Everything around it stays quiet, mature and dependable.

Built with guidance from ui-skills.com sources read as plain markdown: Anthropic `frontend-design` (plan first, avoid generated-UI tells), Jakub Krehel `better-ui` (exact polish values), ibelick `baseline-ui` (one accent per view, no glow or purple gradients).

## Foundations

| Role | Light | Dark |
|---|---|---|
| Ground | `#F7F7F5` | `#0F1013` |
| Surface / raised / sunken | `#FFFFFF` / `#F1F1EE` / `#ECECE8` | `#17181C` / `#1E1F24` / `#121316` |
| Text / muted / faint | `#17181C` / `#5B5E69` / `#767985` | `#F2F2EF` / `#A6A8B1` / `#8C8F99` |
| Accent (actions, links, focus only) | cobalt `#2B50E8` | `#6E8BFF` |
| Success / warning / danger | `#0F7A4F` / `#8A5A00` / `#B42318` | `#4ACB91` / `#F2C14E` / `#FF7B6E` |
| Person colours (mean "this person" only) | coral `#F0643C`, saffron `#E3A008`, mint `#16A672`, sky `#2E8FD8`, violet `#7C5CE6`, rose `#DB4C86` | same |

- **Type:** Bricolage Grotesque for headlines (700, tight), Hanken Grotesk for the interface, JetBrains Mono only inside commands.
- **Surfaces:** layered shadow rings for elevation; borders only for structure (tables, inputs, dividers). Radius 14px cards, 10px controls.
- **Motion (better-ui values):** press scales to 0.96 over 150ms; hover only under `(hover: hover)`; transitions name their properties; one orchestrated entrance (100ms stagger, 4px blur, 12px rise, 300ms); the weave draws once, then pulses travel along threads and pause off-screen; theme switches never animate; everything gated by `prefers-reduced-motion`.
- **Copy:** sentences, not dot-joined fragments; no eyebrow labels; buttons name the action.

## Components

App shell (sidebar with the threads mark, search/⌘K, five sections, theme toggle, user), page header (display title + one sentence), feed card with thread timeline beside one quiet rail, tables with person avatars and access chips, inline invite panel, empty states drawn as small thread knots, command boxes, join checklist with progress.

## Open items

No commissioned logo yet (the mark is three threads becoming one). Example names on the landing are synthetic and labelled as example activity.
