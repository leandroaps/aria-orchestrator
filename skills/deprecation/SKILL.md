---
name: deprecation
effort: medium
description: >
  Decide whether code, a dependency, a route, a column or a user-facing
  feature should go, measure who still uses it, and remove it without breaking
  them, including schema changes done as expand, migrate, contract. Use when
  retiring a feature, replacing an implementation, removing dead code or an
  unused dependency, or dropping or renaming a column.
---

# Deprecation: removing is engineering too

Adapted from `deprecation-and-migration` in `addyosmani/agent-skills` (MIT);
see `THIRD_PARTY_NOTICES.md` in the plugin.

Code is a cost: it needs reading, updating and securing. Every observable
behaviour ends up depended on by someone (a page, a test, a bookmark, a
translation key), so removing well means measuring first.

## Decide

Answer before touching anything:

1. Does it still give something nothing else gives? If yes, keep it.
2. Who uses it? (Measure: next section.)
3. Is there a replacement? If not, build it first.
4. What does each consumer pay to migrate?
5. What does keeping it cost: security, confusion, maintenance?

A **user-facing** feature or route needs a spec (and an ADR, if the project
keeps them) before removal. Internal dead code needs at least a commit
message that says why.

## Measure usage

- References: search the source, the tests, the scripts and the docs.
- Dependencies: the project's unused-dependency check, or the lockfile
  against the imports.
- Copy: translation keys are removed from every locale together, never one.
- Routes: links, the sitemap, the test suite; a public URL may need a
  redirect instead of a 404.
- Specs: a requirement that still describes the behaviour must be marked
  superseded, not left lying.

## Replacing an implementation: compare before removing

When a new implementation replaces an old one, run **both on the same
inputs** before the old one goes: an equivalence property for pure logic,
the same end-to-end run against both for anything with I/O. Every
difference is either a bug in the new version or a deliberate change. List
the deliberate ones in the spec's `design.md`, each with its reason; a
difference not on that list blocks the removal. Remove the old version and
the comparison together.

## Remove

1. Migrate consumers one at a time; verify each.
2. Remove the code, its tests, its copy, its docs and its config together.
3. Update the `Status:` of any spec whose requirement stopped being true.
4. Run the project's checks and the related tests.

## Schema: expand, migrate, contract

Stored data is the one thing a code revert does not roll back. Never rename
or drop a column in the same deploy that stops using it.

1. **Expand**: add the new column or table, nullable, through the project's
   migration tool, after confirming which database it targets.
2. **Migrate**: write both shapes, backfill in small batches, switch reads.
3. **Contract**: in a later, separate migration and deploy, once no code
   reads the old shape, drop it, following the project's process for a
   destructive migration.

## Red flags

- Removing without measuring usage.
- A copy key removed from one locale only.
- A drop shipped in the same deploy as the code that stopped reading it.
- A requirement still describing removed behaviour as current.
- New features added to something already being deprecated.
