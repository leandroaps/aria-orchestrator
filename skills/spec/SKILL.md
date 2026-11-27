---
name: spec
effort: high
description: >
  Write, review or update a spec (requirements.md with numbered EARS
  acceptance criteria, design.md, tasks.md with owners and task-meta) and keep
  its status honest as work lands. Use when the owner or the Lead needs to
  draft a new spec, split an oversized one, plan delegation from an existing
  one, or close one out.
---

# Spec: writing, planning and closing

A spec lives in `<specs.dir>/NNNN-slug/` (`specs.dir` in `aria.config.json`,
default `specs`), in three files read and written in this order:

```text
requirements.md   WHAT and WHY: numbered acceptance criteria (R#.#)
design.md         HOW: architecture, data, risks, alternatives
tasks.md          IN WHAT ORDER: verifiable tasks (T#), each citing R#.#
```

Start from the plugin's templates, `templates/spec/`. Each file opens with
`**Spec ID:** NNNN` and `**Status:** …` in its first lines; the parser reads
them there.

The quality bar is single and practical: **can an agent who reads only the
spec implement it and prove it was implemented?** If not, a requirement or
an observable criterion is missing.

## Before writing: look for precedent

If the request is still vague (no clear user, reason, success criterion or
constraint), run the `interview` skill first; its confirmed restate becomes
sections 1 to 3 of `requirements.md`.

Most decisions in a repository were already made once, and redoing one
differently is the main way to damage the foundation. Before proposing
architecture, search the existing specs and ADRs for the topic, and list
which specs say `Status: Implemented`. Cite the earlier spec instead of
rewriting its decision.

## Numbering and status

- Four digits, sequential, **never reused**. Gaps are permanent.
- A slug that names the subject, not the verb: `0013-partner-registration`.
- The id never changes once created; commits and other specs cite it.

| Status | Meaning |
|---|---|
| `Draft` | Being written or waiting for approval. Nothing implemented. |
| `Approved` | The owner approved the plan. Implementation may start. |
| `Implemented` | In the code. If something was left out, say what, on the same line. |
| `Superseded` | Replaced: name the specs that replace it, by number. |

A partial status is written in full, never rounded up:
`Implemented (server and UI); load tests deferred to spec 0031`.

## `requirements.md`

The only document that creates a requirement.

- **Summary**: one to three sentences, including the trigger, what changed
  for this spec to exist now.
- **Goals**: measurable. "Improve security" is not a goal; "every new route
  answers 401 without a session" is.
- **Non-goals**: the most underrated section. It keeps a worker from widening
  the scope, and lets the owner decline a request later without an argument.
- **User stories and acceptance criteria**: `R#` per story, `R#.#` per
  criterion, in EARS. Every `R#.#` becomes a test.
- **Constraints and assumptions**: what you assumed that, if false,
  invalidates the design, including the runtime's limits.
- **Open questions**: leave open what is genuinely open.

For every criterion, ask _which assertion proves this?_ If the answer is "it
depends", rewrite it. Cover the unhappy path: every rule that can be broken
deserves an `IF … THEN`, so the test author does not have to invent the
expected behaviour.

### EARS

- **Event-driven:** `WHEN <trigger>, the system SHALL <response>.`
- **Unwanted behaviour:** `IF <condition>, THEN the system SHALL <safe response>.`
- **Ubiquitous:** `The system SHALL <always true>.`
- **State-driven:** `WHILE <state>, the system SHALL <response>.`
- **Optional:** `WHERE <feature>, the system SHALL <response>.`

`SHALL` and `SHALL NOT`, never "should" or "may"; one behaviour per item; an
explicit subject; observable from outside.

## `design.md`

Answers _how_, always on top of an existing `R#.#`. Two sections tend to be
skipped and matter most:

- **Migrations and rollout**: if the spec touches stored data, say whether
  the change is destructive. A destructive change ships as expand, migrate,
  contract, across separate deploys: a code rollback never rolls back data.
- **Risks and alternatives considered**: what you rejected and why.

## `tasks.md`

- `T1..Tn` in execution order. Each task names its owner in parentheses
  after the title, an agent of `aria.config.json` or `lead` for the main
  session, and cites the `R#.#` it satisfies: `- [ ] **T2** Title (`backend`) → R1.1`.
- Each task has a `task-meta` block with `depends_on`, `allowed_paths` (inside
  the owner's territory, or `[]` for no writes), `verification` and, when it
  needs one, `exclusive_resources` (a port, a shared database).
- A task is small and **independently verifiable**. "Implement the feature"
  is not a task; "create the table and its migration → R2.1" is.
- **The test comes before the code it proves.** When a spec changes
  behaviour, the test task depends only on the shared contract, and the
  implementation tasks it proves list it in `depends_on`. A test that already
  passes before the implementation proves nothing.
- **"Done" is declared before the code.** Every writer task carries its own
  `verification` (a test file, a script with an exit code), not only the
  owner's default from `aria.config.json`. Read-only tasks need one too.
- The close-out task reruns the tests that proved the change and records
  that they pass.
- The **last task marks the pull request ready for review**; the pull
  request itself was opened as a draft when implementation started.
- When a requirement is verified outside any task (a manual check on a
  device, an external audit), list it under
  `## Manual/external verification`, with who verifies it and how.
- On completion, check the box and write on the same line where it landed.

Check the result with `aria validate spec <spec>` and
`aria validate graph <spec>`.

## Planning the delegation

Once the spec is read, build the plan and **stop**: no file is touched before
the owner approves (the `orchestrate` skill, step 4). The plan needs a task
breakdown, an owner per task, an order, and the shared-contract changes.
Classify the impact before delegating: a high-impact spec gets `security`
before dispatch and before done.

## When to split a spec

Signs that it is really two: the criteria fall into two groups that never
cite each other; one half is infrastructure and the other is domain; or the
spec needs two deploys to be safe. Create the new specs with new numbers,
mark the original `Superseded` citing its successors, and do not delete it.

## Closing a spec

- Every `R#.#` verified, or listed as unverified with the reason.
- `Status:` updated in all **three** files, with the partial part spelled
  out.
- Done criteria checked; what did not pan out stays unchecked with the
  reason. A box checked out of optimism is worse than an open one.
- If the implemented behaviour diverged from what was written, update the
  spec to describe what exists, with the scope change recorded. A document
  that lies is worse than no document.
- If the spec introduced a pattern inside an owner's territory that the
  owner's agent or skill does not reflect yet, update it in the same pull
  request, and record the decision on the closing task either way.

## Common mistakes

| Mistake | Correct |
|---|---|
| A criterion with no trigger or no observable response | `WHEN <trigger>, the system SHALL <verifiable response>` |
| Happy path only | Every rule that can be broken gets an `IF … THEN` |
| Two `SHALL`s in one item | One behaviour per item: two tests, two numbers |
| A new requirement in `design.md` or `tasks.md` | Send it back to `requirements.md` with its own number |
| Empty non-goals | They hold the line on scope later |
| Reusing a discarded number | Sequential; gaps are permanent |
| `Implemented` with a hidden loose end | Write the loose end on the same line |
| Starting because the plan "obviously" is small | The approval gate has no exception |
| Re-deciding what another spec decided | Cite it; changing it needs a reason |
