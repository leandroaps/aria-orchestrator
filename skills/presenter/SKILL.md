---
name: presenter
effort: low
description: >
  Review one spec for verifiable coherence against seven mechanical checks
  (status against the disk, requirements and tasks citing each other, ADRs
  cited both ways, divergence notes, coverage run or marked, numbering never
  reused), and keep an evidence-backed presentation of the project's real
  state. Use when the owner or the `presenter` agent needs to review a spec's
  coherence, or update the state-of-the-project presentation.
---

# Presenter: coherence of specs and the project's real state

`Status: Implemented` is a claim about the moment it was written, not
evidence that the behaviour exists now. Old specs can describe code that was
since removed, rewritten, or that came from another repository. This role
checks claims against the disk and reports; it never edits what it audits.

## The seven checks, in order

For a spec `<specs.dir>/<spec>/`:

### 1. Status matches the disk

Read the `Status:` line of the three files. For every file, route, script or
command the status or the body cites as existing, check it exists. A
`Status: Implemented` with nothing backing it (no test cited, no commit, no
recorded run) is a finding.

### 2. Every `R#.#` is cited by some `T#`

`aria validate spec <spec>` reports a requirement no task cites. A
requirement listed under `## Manual/external verification` in `tasks.md` is
a documented exception, not a finding.

### 3. Every `T#` cites an existing requirement

Also from `aria validate spec`. A task with no requirement is scope that came
in through the back door.

### 4. ADR present and cited both ways

If the project keeps ADRs, the spec cites the ADR by number and the ADR cites
the spec. A closed spec that made an architectural decision with no ADR is
incomplete, when the project's rules say so.

### 5. Divergence declared

A spec written before an ADR that contradicts it carries a header note
saying so. Without the note, it is a finding.

### 6. Coverage run or marked

An `Implemented` that cites no run of its tests (a date, a pass count, a
check on a pull request) is an unverified `Implemented`. Mark it as such; do
not erase the distinction.

### 7. Numbering never reused

The spec's number, and any ADR's, collides with no other. Gaps are
permanent; a gap is never a finding.

## What you do with what you find

You **fix nothing** in the specs or ADRs: you report to the Lead which check
failed, what the disk shows and the correction you propose. The Lead edits.
Never renumber, never create a requirement.

```text
[Incoherence] <specs.dir>/0029-authentication/requirements.md:3
Status: Draft, but the sign-in route and its tests exist and pass in CI.
No divergence note in the header.
Proposed fix: update Status to Implemented, citing the test run.
```

One finding per entry: the check that failed, what the disk shows, and the
proposed fix.

## The presentation

When the project wants a state-of-the-project presentation, keep its source
in the folder the project assigns to the `presenter` agent in
`aria.config.json`, and publish it where the owner wants it shared. Minimum
content:

- The specs by real state, keeping verified `Implemented` apart from
  unverified `Implemented`.
- The named debt: known failures, and what is believed about each.
- Progress measured by something objective (test counts over time, specs
  closed with evidence), not by status lines.
- What is in production and what is not.

Every "done" claim carries its evidence (a dated run, a spec status, a check
on a pull request) or is marked unverified. No exception.
