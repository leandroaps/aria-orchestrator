# Plan 0002 — Brand identity and experience layer

Status: In progress
Date: 2026-11-27

## Goal

Give ARIA one visual identity and one way of presenting itself — in the
docs, the landing page, the terminal and Claude Code — without adding AI
calls, tokens or dependencies for presentation, and without touching what
the engine does.

## Principle for sequencing

Presentation follows the thing it presents. A renderer, command or status
line is built in the same phase as the capability it shows, never ahead of
it, so progress on screen always comes from real state. Plan 0001's layout
(`lib/`, `bin/`, `assets/`, `docs/`) is kept; no `packages/`/`apps/` split.

## Phases

- **B1 — Identity (now, independent of plan 0001).** Logo files and
  rendered variants in `assets/brand/` and `site/`; `brand-tokens.json`
  (colours, status colours and symbols with ASCII fallbacks, fonts, copy);
  `docs/brand/identity.md`; README header; plugin icon; static landing page
  in `site/`. Tests keep the tokens valid and the site copies equal to their
  sources.
- **B2 — Terminal layer (with plan 0001 P3, the CLI).** `lib/experience/`:
  tokens → ANSI, colour detection (`NO_COLOR`, `FORCE_COLOR`, TTY, CI,
  Windows/WSL), Unicode/ASCII symbols, verbosity levels (minimal default,
  standard, debug), and a guarantee that `--json` output carries no banner
  or escape code. `aria status` renders the real run: run states from
  `RUN_STATES` and task states from the run directory. Security warnings,
  failures and pending approvals show at every verbosity.
- **B3 — Claude Code surface (with P4/P5, hooks and skills).** ARIA output
  style and persona, session banner, optional status line. Each depends on
  a Claude Code behaviour to verify first, as plan 0001 already requires:
  1. whether a plugin can ship an output style;
  2. how, and whether, a `SessionStart` hook can show text to the user
     (rather than only to the model);
  3. the status line is a user or project setting, not a plugin one: the
     plugin ships the script, and enabling it is opt-in, merged into the
     project's settings, and reversible. Global user settings are never
     changed without the owner's explicit approval.
- **B4 — Lifecycle view (with P5, workflows).** Map the real workflow
  stages (`aria-plan`, `aria-execute`, `aria-review` and the skills they
  call) before naming any stage on screen.

## Outside the repository

The GitHub avatar (account or the farofino-bot app) is uploaded by hand
from `assets/brand/aria-icon.png` (768 px, about 0.5 MB, under the 1 MB
limit). A production domain for the landing page is not chosen yet.
