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

## Landing page

`site/` is a static page (HTML and CSS, no framework, no external request,
no tracking) centred on Midnight: the mark, and below it the signature.

| Line | Colour |
|---|---|
| `A R I A` (the name, letter-spaced) | Snow |
| `AGENTIC SDLC ORCHESTRATOR` | Violet |
| `Complexity orchestrated.` | Snow |
| `Simplicity delivered.` | Violet |

Violet on Midnight has a 3.3:1 contrast, which WCAG AA accepts only for
large text, so the violet lines stay at 19.2 px with weight 600 or larger.
Headings stay modest: the name is 28 px. The only motion is a fade on first
load, skipped under `prefers-reduced-motion`.

It is published to GitHub Pages at
<https://leandroaps.github.io/aria-orchestrator/> by
`.github/workflows/pages.yml`, on every push to `main` that touches
`site/`. The Open Graph URLs are absolute and point there; change them in
`site/index.html` (and the brand test) if the page moves to another domain.
The page has no build step, so any static host can serve `site/` as-is.
