# Design: contexter web app

The familiar category standard, executed carefully: a calm, dense team-admin product that stays friendly. Craft bar: Linear (density and calm), Notion/Slack team admin (approachable access and invites), Vercel (crisp type and status feeds).

## Foundations

Palette source: the ui-ux-pro-max "Remote Work / Collaboration Tool" family (calm indigo + success green on a soft lavender ground), with every role named and contrast-checked. Light is the default; dark (deep indigo) is one click or the `T` key away.

| Role | Light | Dark |
|---|---|---|
| Ground | `#F5F3FF` + soft indigo glows | `#0C0B1E` + indigo glow |
| Surface / raised | `#FFFFFF` / `#EEF0FD` | `#14132E` / `#1C1B40` |
| Text / muted | `#1E1B4B` (14.6:1) / `#475569` (6.9:1) | `#EEF0FF` (17:1) / `#A9ACD9` (8.3:1) |
| Border | `#E0E7FF` / strong `#C7CDF3` | indigo 14% / 26% |
| Primary (fills) | `#4F46E5`, white text 6.3:1 | `#818CF8`, `#0F172A` text 6.0:1 |
| Secondary (rings, gradients) | `#818CF8` | `#6366F1` |
| Success | text `#047857`, dot `#059669`, soft `#D1FAE5` | `#34D399` |
| Warning | `#B45309` on `#FEF3C7` | `#FBBF24` |
| Danger | `#B91C1C` on `#FEE2E2` | `#F87171` |

Notes: the database's black-on-indigo pairing was replaced because it falls short of 4.5:1 for white-on-`#6366F1`; filled indigo uses `#4F46E5`. Indigo as text uses `--accent-ink`.

- **Type:** Plus Jakarta Sans (the skill's "Friendly SaaS" pairing; 800 for display, 700 headings, 400/500 body), JetBrains Mono for commands and refs only.
- **Elevation:** declared once, as 1px borders. Shadows only on floating layers and the primary button's lift.
- **Shape:** 12px cards, 7-10px controls, pills for badges, chips and the headline pill.
- **Motion:** 150-250ms exponential ease-out; cross-page view transitions with a sliding nav highlight; staggered feed rows; a Live dot that pulses only because the feed is live; reduced-motion respected.
- **Signature:** the headline pill with cycling phrases, the product window on the landing, and the ⌘K palette (also `/`), with single-key shortcuts T, I, G F, G P.

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
