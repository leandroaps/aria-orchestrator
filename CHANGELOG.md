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
- Brand identity (plan 0002, phase B1): approved logo and its vector,
  monogram, favicon, app and Open Graph variants; `brand-tokens.json`
  (colours, status colours and symbols with ASCII fallbacks, fonts, copy);
  `docs/brand/identity.md`; README header; plugin icon; static landing page
  in `site/`, published to GitHub Pages. Below the logo it shows the name,
  the descriptor and the slogan, in Snow and Violet.
