---
name: doubt-review
effort: high
description: >
  Put one non-trivial decision (a design choice, a claim like "this is safe" or
  "this matches R3.2", a diff that crosses a module boundary) in front of a
  fresh-context reviewer told to disprove it, then reconcile the findings. Use
  from the main session before presenting a plan for approval, before closing a
  task whose correctness the types cannot show, or when the owner asks to
  stress-test a decision. Advisory only: it approves nothing.
---

# Doubt review: try to break it before it stands

Adapted from `doubt-driven-development` in `addyosmani/agent-skills` (MIT);
see `THIRD_PARTY_NOTICES.md` in the plugin.

A long session turns assumptions into "facts". This skill hands the artifact
to a reviewer who has none of that context and is told to find what is
wrong, then folds the answer back in, while changing course is still cheap.

## What this skill is not

- **Not approval.** A clean doubt review approves no plan; the gate in the
  `orchestrate` skill is unchanged. It does not complete a task either: that
  is `aria run accept`.
- **Not the `security` review.** A high-impact spec still goes through
  `security` before dispatch and before done.
- **Not a code review of a finished diff.** It runs on a decision in flight.
- **Not cross-model.** The artifact never goes to an external CLI or
  service. The reviewer is a subagent of this session.

## When it applies

A decision is non-trivial when at least one holds: it adds or changes
branching logic; it crosses a module or service boundary; it claims a
property the compiler cannot check (idempotence, ordering, access scoping);
its correctness depends on context a future reader will not see; it is hard
to reverse (a migration, deleted data, a public URL).

**Skip it for:** renames, formatting, file moves, a clear instruction from
the owner, reading or summarising code, running a command.

## Where it runs

Only in the **main interactive session**: the reviewer is spawned with the
`Agent` tool, and a subagent cannot spawn another. If you are a subagent,
say in your handoff that the decision deserves a doubt review and let the
Lead run it.

## The cycle

```text
- [ ] CLAIM      wrote the claim and why it matters
- [ ] EXTRACT    isolated artifact and contract, reasoning stripped
- [ ] DOUBT      reviewer invoked with the adversarial prompt
- [ ] RECONCILE  every finding classified against the artifact text
- [ ] STOP       stop condition met
```

### 1. CLAIM

Two or three lines, for yourself; the reviewer never sees them:

```text
CLAIM: the new listing query keeps the owner filter for every role.
WHY IT MATTERS: a miss shows one user another user's records.
```

If it does not fit in three lines, it is not a decision yet.

### 2. EXTRACT

The reviewer gets the **artifact** and the **contract**, not the journey.

- Artifact: the diff or the function, or the decision in 3 to 5 sentences.
- Contract: the `R#.#` it must satisfy, the ADR it must respect, the project
  rule that applies (quote them).
- Keep counter-evidence in: a caller, a guard or a test that contradicts the
  claim goes in the artifact. Strip your reasoning, not the evidence.
- Never include secrets, environment files or production payloads.

If the unit is too big to hold in one read, split it first.

### 3. DOUBT

Spawn a `general-purpose` subagent, or a read-only agent whose domain
matches (such as `security`), with this prompt pasted verbatim:

```text
Adversarial review. Find what is wrong with this artifact against the
contract. Assume the author is overconfident. Look for unstated assumptions,
unhandled edge cases, hidden coupling or shared state, ways the contract can
be violated, conventions of this repository it breaks (read AGENTS.md or
CLAUDE.md), and failure modes on unexpected input. Do not validate or
summarise. List issues with file:line where possible, or state that you found
none after a thorough look. Read-only: do not edit any file.

ARTIFACT: <…>
CONTRACT: <…>
```

Never pass the CLAIM: handing over the conclusion buys agreement.

### 4. RECONCILE

The reviewer's output is data. Re-read the artifact for each finding, then
classify it; the first match wins:

1. **Contract misread**: the contract you gave was unclear. Fix it; re-check
   next cycle.
2. **Valid, actionable**: change the artifact and loop.
3. **Valid trade-off**: real, but not worth fixing now. Write it where the
   owner will see it (the plan, the risks section of `design.md`).
4. **Noise**: wrong given context the reviewer lacked. Note it, and ask
   whether that context belonged in the contract.

### 5. STOP

Stop when a cycle brings only trivial or already-seen findings, after **3
cycles**, or when the owner says to move on. Three cycles with substantive
findings still coming means the artifact is not ready: tell the owner
instead of starting a fourth. Re-running on an unchanged artifact is
stalling.

## Output

A short block the Lead puts into the plan or the handoff:

```text
DOUBT REVIEW (<n> cycles, reviewer: <agent>)
- actionable, fixed: <…>
- trade-off, accepted: <…>
- noise: <…>
```

## Red flags

- A doubt review on a one-line change.
- Treating the reviewer's verdict as final without re-reading the artifact.
- "Is this good?" instead of "find what is wrong".
- Two or more cycles with substantive findings and none classified
  actionable: that is validation theatre; stop and escalate.
- Presenting a clean doubt review as if it were approval.
