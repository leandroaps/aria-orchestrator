# Changelog

## Unreleased

### Added

- Repository scaffold: plugin and marketplace manifests, MIT license,
  `node:test` setup and CI (plan 0001, phase P0).
- Node.js policy: always the active LTS, currently 24, pinned in `.nvmrc`
  and used by CI and `engines`. A test enforces it: `.nvmrc`, `engines`,
  the test runtime, `node-version-file` in the workflows, and every GitHub
  Action pinned to a release that runs on Node 24.
- Engine (plan 0001, phase P1): `lib/` modules for config, spec parsing,
  execution graph, shared approval registry, run state (manifest, approval,
  concurrency, defects, locks) and evidence (tree delta, sensitive set,
  snapshot verification), extracted from bernardo-pet. Project values come
  from `aria.config.json`; runtime state lives in `.aria/`. Covered by
  `node:test` suites against temporary git repositories.
- Config (plan 0001, phase P2): JSON Schema in
  `schema/aria.config.schema.json`; the loader reports every problem at
  once, each with its location (`agents.api.mode`), and rejects unknown keys
  with a "did you mean" hint; starter config in `templates/aria.config.json`;
  `aria validate config` (`--root`, `--json`; exit 0/1/2). Tests keep the
  schema and the loader in step on the same corpus of valid and invalid
  configs.
- CLI, first part (plan 0001, phase P3.1): `aria validate spec`, `validate
  graph`, `validate handoff` (with `--base`, against the real change),
  `validate run`, `scope` and `classify`. The checks live in
  `lib/validate.mjs` and `lib/impact.mjs`. Changes to governance files
  always require `security`, from a list fixed in code. A required reviewer
  missing from `aria.config.json` is reported and fails `classify`. The
  root defaults to the git top level.
- CLI, run commands (plan 0001, phase P3.2a): `aria run create`, `plan`,
  `status`, `record-approval`, `start`, `verify`, `accept`, `ready`,
  `fail`, `resume`, `recover-lock` and `cancel`, ported from bernardo-pet
  `agent-run.mjs` into `lib/run-controller.mjs`. Plain or `--json` output;
  exit 1 on a refusal. Run ids, task ids, lock keys and defect categories
  are checked before use. An approval counts only when the plugin's own
  question hook wrote the event.
- Terminal layer and `aria status` (plan 0001 P3.2b, plan 0002 B2):
  `lib/experience/` turns the brand tokens into ANSI (true colour when the
  terminal says so, else the nearest basic colour), detects colour
  (`NO_COLOR`, `FORCE_COLOR`, TTY, CI, `TERM=dumb`) and Unicode (ASCII on
  the Linux console and the legacy Windows console), and has three
  verbosity levels. `aria status [<run-id>]` summarises a run with its next
  step. `--json` never carries an escape code. Phase P3 is done.
- Hooks (plan 0001, phase P4), wired in `hooks/hooks.json` and ported from
  bernardo-pet: the question hook (the only source of an approval; the
  template's text in `locales/en.json` and `locales/pt-BR.json`), the
  prompt hook, the tool guard (territory, sensitive set, read-only
  auditors, the `pr` agent, `Stop`), and the push gate with `aria gate`.
  The gate runs aria's own checks in-process instead of project scripts.
  `aria run plan` returns the exact `approval_question`, and
  `record-approval` now works end to end. Phase P4 is done.
- Skills, agents and workflows (plan 0001, phase P5), generalised from
  bernardo-pet:
  - skills `orchestrate`, `spec`, `interview`, `reality-check`,
    `doubt-review`, `source-grounding`, `pr-review`, `debugging`,
    `deprecation`, `presenter`, and stack-neutral `test` and `security`;
  - `follow-run`, the `/loop` tick that replaces bernardo's `.claude/loop.md`;
  - agents `controller`, `security`, `test`, `pr` and `presenter`;
  - workflows `aria-plan`, `aria-execute` and `aria-review`, which keep the
    manual protocol as a fallback;
  - spec templates in `templates/spec/`;
  - `aria validate contracts` (skill anatomy, agents, plugin-ignored
    fields, dead paths, and the project's `contracts.forbidden` rules, a new
    config key), `aria validate workflows`, and `aria run select` and
    `run observe` for `/loop`;
  - the tool guard recognises the plugin's agents under their plugin-scoped
    name, and `run select` belongs to the main session.

  Phase P5 is done. `THIRD_PARTY_NOTICES.md` credits the adapted material.
- End-to-end test (plan 0001, phase P6), `test/e2e.test.mjs`: a fixture
  repository with an `origin` runs the three workflows under a simulated
  workflow runtime. The owner clicks through the real question hook, and
  every agent's write and command first passes the real tool guard. It
  covers a full run (plan, click, execute, the Lead's commit, review, the
  loop stopping for review), a run that is never approved (a prefilled
  answer, a typed approval), an approval voided by a plan change, and a
  worker that writes out of territory: the guard denies the write, and a
  write around the guard is refused by `accept` until the third identical
  defect blocks the run. `aria-plan` no longer repeats an impact problem
  once per task. Phase P6 is done.
- First real validation (plan 0001, phase P7), in
  `docs/validation/0001.md`. Fixes from it:
  - `bin/aria`, so `aria` runs as a bare command from the plugin's `bin/`;
  - the tool guard no longer reads a heredoc's body as shell, unless an
    interpreter runs it, and treats `node < file` and `node <<EOF` as opaque
    `node`;
  - English is the stated default everywhere; `locale: pt-BR` only on
    request.
- Project page: the name's meaning, "Agentic Reasoning and Intelligent
  Automation", right under "ARIA". The language and theme controls now
  stack above the page: on a phone, `<main>` covered them and a click on
  the theme button or a language link did nothing.
- Project page at https://aria-orchestrator.dev (`site/`, its own package):
  - React prerendered to static HTML, in English, Brazilian Portuguese and
    Spanish, with light and dark themes;
  - install commands, phase status from `docs/plan/status.json`, and the
    latest GitHub releases;
  - an author footer;
  - served by a Cloudflare Worker that also redirects `www`, and deployed
    by `.github/workflows/site.yml` on pushes to `main` and on published
    releases.

  GitHub Pages is retired: its workflow is removed and the repository
  homepage points at the new domain.
- Brand identity (plan 0002, phase B1): approved logo and its vector,
  monogram, favicon, app and Open Graph variants; `brand-tokens.json`
  (colours, status colours and symbols with ASCII fallbacks, fonts, copy);
  `docs/brand/identity.md`; README header; plugin icon; static landing page
  in `site/`, published to GitHub Pages. Below the logo it shows the name,
  the descriptor and the slogan, in Snow and Violet.
