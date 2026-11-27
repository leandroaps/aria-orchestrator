# Changelog

## Unreleased

### Added

- Repository scaffold: plugin and marketplace manifests, MIT license,
  `node:test` setup and CI (plan 0001, phase P0).
- Node.js policy: always the active LTS, currently 24, pinned in `.nvmrc`
  and used by CI and `engines`.
- Engine (plan 0001, phase P1): `lib/` modules for config, spec parsing,
  execution graph, shared approval registry, run state (manifest, approval,
  concurrency, defects, locks) and evidence (tree delta, sensitive set,
  snapshot verification), extracted from bernardo-pet. Project values come
  from `aria.config.json`; runtime state lives in `.aria/`. Covered by
  `node:test` suites against temporary git repositories.
