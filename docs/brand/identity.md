# ARIA brand identity

**ARIA** — **A**gentic **R**easoning and **I**ntelligent **A**utomation.
Agentic SDLC Orchestrator.

> Complexity orchestrated. Simplicity delivered.
>
> Many agents. One intelligence.

The machine-readable source for everything below is
[`assets/brand/brand-tokens.json`](../../assets/brand/brand-tokens.json).
Code reads the tokens from that file; nothing else redefines them.

## Logo

| File | Use |
|---|---|
| `assets/brand/aria-icon.png` | Approved original (768 px). Plugin icon, GitHub avatar. |
| `assets/brand/aria-icon.svg` | Vector of the same logo, with its square background. Favicon. |
| `assets/brand/aria-mark.svg` | The monogram alone, cropped, no background. Use on Midnight. |

Rules:

- Do not redesign, recolour or reinterpret the monogram.
- Do not add shadows, outlines, glows or decorative elements.
- Keep the proportions; scale only.
- On a page, place the mark on Midnight (`#0B1020`). The approved square
  background is slightly darker (`#05061C`); use the icon files where a
  square tile is expected (favicons, avatars, app icons).

Raster variants for the landing page live in `site/` (favicon 32 px, Apple
touch icon 180 px, manifest icons 192/512 px, Open Graph image 1200×630).
They were rendered from `aria-icon.svg`; the tests check that the copies in
`site/` match the sources in `assets/brand/`.

## Colour

| Token | Hex | Role |
|---|---|---|
| Midnight | `#0B1020` | Primary background |
| Surface | `#181F33` | Secondary background |
| Border | `#334155` | Subtle borders |
| Violet | `#7C3AED` | Primary brand colour |
| Lavender | `#A78BFA` | Secondary brand colour |
| Cyan | `#22D3EE` | Accent |
| Snow | `#F8FAFC` | Primary light text |
| Muted | `#94A3B8` | Secondary text |

The violet → cyan gradient belongs to the logo. Avoid gradients elsewhere.

### Status

States shown to the user always reflect real execution state. Each has a
colour, a Unicode symbol, and an ASCII fallback for terminals without
Unicode or colour.

| State | Colour | Symbol | ASCII |
|---|---|---|---|
| success | `#34D399` | ✓ | `[ok]` |
| warning | `#FBBF24` | ! | `[!]` |
| error | `#F87171` | ✗ | `[x]` |
| info | `#22D3EE` | i | `[i]` |
| pending | `#94A3B8` | ○ | `[ ]` |
| running | `#A78BFA` | → | `[>]` |
| awaiting_approval | `#FBBF24` | ◆ | `[?]` |
| skipped | `#94A3B8` | – | `[-]` |
| blocked | `#F87171` | ■ | `[#]` |

Colour is never the only signal: the symbol or the word carries the state.

## Typography

| Family | Use | Fallback |
|---|---|---|
| Inter | Interface, headings, communication | `ui-sans-serif, system-ui, …` |
| JetBrains Mono | CLI, code, technical information | `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` |

Keep the hierarchy clear and headings modest. Pages use the system stack
when the font is not installed; no font is downloaded from a third party.

## Principles

Minimalism, simplicity, accessibility, consistency, progressive disclosure,
clear hierarchy, low cognitive load, function over decoration. No emojis,
decorative icons, heavy borders or continuous animation.

## Voice

ARIA speaks as an experienced engineering mentor: calm, direct, precise,
collaborative. It leads with the result, names blockers and decisions
plainly, and keeps internal complexity out of sight. No artificial
enthusiasm, no filler. ARIA is the orchestration layer; it never claims to be
the underlying model or provider.

## Project page

<https://aria-orchestrator.dev> is built from `site/`:
- React components are rendered to static HTML at build time;
- one page per language: English at `/`, Brazilian Portuguese at `/pt-br/`,
  Spanish at `/es/`;
- a Cloudflare Worker serves the pages.

No React code, font or tracker reaches the browser. The only script is a
small inline one for the theme switch.

**Layout.** The mark comes first, with the signature below it:

| Line | Colour |
|---|---|
| `A R I A` (the name, letter-spaced) | Text (Snow in dark, Midnight in light) |
| `AGENTIC SDLC ORCHESTRATOR` | Violet |
| `Complexity orchestrated.` | Text |
| `Simplicity delivered.` | Violet |

Then come the install commands, the status of each phase (from
`docs/plan/status.json`) and the latest releases (from the GitHub API at
build time). The language links and the theme button share the top right
corner. The footer always sits at the bottom and carries the author's
mark and credit line. Its heart emoji is the one exception to "no emojis",
at the author's request.

**Themes.** Dark is Midnight with Snow text. Light is Snow with Midnight
text. The page follows the system until the visitor picks one, and the
choice is kept in `localStorage`.

**Contrast.**
- Violet on Midnight is 3.3:1, which WCAG AA accepts only for large text,
  so violet text in the dark theme stays at 19.2 px and weight 600 or
  larger.
- Links use Lavender in the dark theme (6.96:1) and Violet in the light
  one (5.4:1).

**Headings and motion.** Headings stay modest: the name is 28 px. The only
motion is a fade on load, skipped under `prefers-reduced-motion`.
