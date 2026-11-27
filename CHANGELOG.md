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
- Project page at https://aria-orchestrator.dev (`site/`, its own package):
  - React prerendered to static HTML, in English, Brazilian Portuguese and
    Spanish, with light and dark themes;
  - install commands, phase status from `docs/plan/status.json`, and the
    latest GitHub releases;
  - an author footer;
  - served by a Cloudflare Worker that also redirects `www`, and deployed
    by `.github/workflows/site.yml` on pushes to `main` and on published
    releases.

  GitHub Pages no longer deploys on push.
- Brand identity (plan 0002, phase B1): approved logo and its vector,
  monogram, favicon, app and Open Graph variants; `brand-tokens.json`
  (colours, status colours and symbols with ASCII fallbacks, fonts, copy);
  `docs/brand/identity.md`; README header; plugin icon; static landing page
  in `site/`, published to GitHub Pages. Below the logo it shows the name,
  the descriptor and the slogan, in Snow and Violet.
