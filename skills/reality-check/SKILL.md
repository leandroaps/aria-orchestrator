---
name: reality-check
effort: low
description: >
  Confront what a spec, an ADR or an agent or skill prompt claims exists with
  what the repository actually holds at the current ref, deterministic checks
  first. Use before planning or dispatching work from a spec (step 1 of the
  `orchestrate` skill), or on its own to investigate one divergence.
---

# Reality check: documentation against the repository

A prompt or a spec can describe tooling, files or behaviour that do not
exist in this repository: copied from another project, written for a plan
that changed, or simply stale. A worker that trusts the claim builds on
something false. So the check is **deterministic first**: yes/no commands,
before any interpretive reading. It is read-only and needs no approval.

## Input

```text
spec (directory name or id), or "general" for a loose check
current ref (usually HEAD of the working branch)
```

## Order of checks (stop at the first `blocking`)

1. **Files and directories** cited as existing in the spec's
   `requirements.md`, `design.md` and `tasks.md`, and in any ADR it cites:

   ```bash
   test -e <path> && echo exists || echo MISSING
   ```

2. **Scripts and commands** the spec relies on, checked against the source of
   truth (`package.json` scripts, a `Makefile`, the CI config), never against
   a document's memory of them.

3. **Routes, entry points and modules** the spec names: the file that
   implements them exists, not just a plausible path.

4. **Cited specs and ADRs**: resolve the chain before treating one as an
   active source. If a spec says `Status: Superseded`, follow it to the spec
   that replaces it; a chain can have more than one hop.

5. **Agent and skill prompts** touching the spec's territory: run
   `aria validate contracts` and check whether a finding touches this area.

6. **The plan's shape**: `aria validate spec <spec>` and
   `aria validate graph <spec>`.

## Severity

- **`blocking`**: an artifact cited as existing does not exist; a
  `Status: Implemented` with no file, command or test backing it; or a
  prompt that prescribes tooling the project does not have as part of its
  current environment.
- **`warning`**: a plausible `Status: Implemented` without specific
  evidence attached (a test case, a commit, a recorded run); a cited spec
  that carries a divergence note.

## Output

The divergence below is an illustration, not a claim about any repository.

```json
{
  "status": "pass | blocked | warnings",
  "spec": "0052-booking",
  "ref": "abc1234",
  "checked": [
    { "kind": "file", "path": "src/lib/duration.ts", "result": "exists" },
    { "kind": "script", "name": "test", "result": "exists" }
  ],
  "divergences": [
    {
      "source": ".claude/agents/devops.md",
      "claim": "the CI workflow runs the e2e suite",
      "observed": "no CI workflow in the repository",
      "severity": "blocking"
    }
  ]
}
```

`status` is `blocked` with at least one `blocking` divergence, `warnings`
with only warnings, `pass` otherwise.

## Hard rule

`blocked` **stops execution before any dispatch**. The Lead records the
divergence and brings it to the owner, for a documentation fix or an
explicit decision, instead of letting a worker build on a claim already
proven false.

This step edits nothing. A divergence inside an agent or skill is reported
as a finding; fixing the prompt is separate work, never an edit in the
middle of another spec's reality check.
