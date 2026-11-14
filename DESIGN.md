# Design: contexter web app

The familiar category standard, executed carefully: a calm, dense team-admin product that stays friendly. Craft bar: Linear (density and calm), Notion/Slack team admin (approachable access and invites), Vercel (crisp type and status feeds).

## Foundations

- **Surfaces:** dark-first. Near-black neutrals tinted toward indigo (hue 275) with a soft indigo/violet atmosphere behind the work (two fixed radial glows); light mode is a secondary theme with the same hues. Hairline translucent borders, translucent blurred sidebar.
- **Accent:** one indigo (`--accent`) for primary actions, selection, focus and the brand mark. Semantic green, amber and red appear only for state (`--ok`, `--warn`, `--danger`).
- **Type:** Figtree for UI (400/500/600/700), JetBrains Mono for commands, refs and codes only. Base 14px, scale 12/13/14/16/24, headings -0.015em.
- **Elevation:** declared once, as 1px borders. Shadows exist only on floating layers (`--shadow-float`, dialogs).
- **Shape:** 12px cards, 7-10px controls, pills only for badges and chips.
- **Motion:** 150-250ms exponential ease-out. Cross-page view transitions with a sliding nav highlight, staggered feed rows on load, a glow sweep for new events, a pulsing Live pill, a drawn check when Claude connects. All motion off under `prefers-reduced-motion`.
- **Signature:** the ⌘K command palette (also `/`), with single-key shortcuts T, I, G F, G P.

## Components

- **App shell:** 232px sidebar (wordmark, Feed / People / Projects / Invitations / Team settings, theme toggle, signed-in user), page header with title, one-line subtitle and the primary action. Below 860px the sidebar becomes a top bar with a scrolling nav row.
- **Buttons:** primary (accent), secondary (bordered), ghost, danger text; 34px default, 28px small. Inputs share the same height and focus ring.
- **Tables:** hairline rows, avatar + email cells, role badges, access chips with inline role selects, row hover. Wide tables scroll inside their card.
- **Avatars:** initials on a hue derived from the name (8 hues), same lightness across hues.
- **Empty states:** simple geometric mark, one line of what it is, one action.
- **Command boxes:** mono text with a copy button that confirms inline.
- **Onboarding checklist:** numbered steps, manual "Mark done", progress bar, the last step completes itself when the first Claude session arrives.

## Rules

- No big-number stat tiles, no eyebrow labels, no gradient text, no emoji as icons. Icons are one 1.75px stroke set drawn in `app.js`.
- The product name lives in one constant (`PRODUCT` in `web/app.js`); the name may change.
- Accessibility: visible focus rings, 4.5:1 text contrast in both themes, labelled controls, polite live regions for results.

## Open items

No logo yet; the brand mark is a placeholder glyph. No real illustrations or screenshots exist. `DESIGN.md` was written by hand at finish because the independent documenter and finish-review agents were not available in this environment, so `.impeccable/design.json` was not generated.
