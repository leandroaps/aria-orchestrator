---
name: test
effort: medium
description: >
  Write tests derived from a spec's acceptance criteria rather than from the
  implementation, each mapped to the R#.# it proves, with the unhappy paths
  covered and the red run recorded before the code it proves exists
  (Prove-It). Use when the `test` agent or the Lead needs to add or update
  tests for a spec.
---

# Test: from the requirement, red first

The Prove-It pattern is adapted from the `test-engineer` agent of
`addyosmani/agent-skills` (MIT); see `THIRD_PARTY_NOTICES.md` in the plugin.

This skill is the method. The project's own conventions (which runner,
where tests live, how fixtures are built) come from the repository: read its
`AGENTS.md` or `CLAUDE.md` and the existing tests before writing a new one,
and follow them. Never add a test runner or framework the project does not
already use; that is a spec decision.

## Derive from the spec, not from the code

- Read the spec's `requirements.md` in full. Your cases come from its
  numbered criteria, not from reading the implementation. A test derived
  from the code confirms its bugs instead of catching them.
- Each test names the `R#.#` it proves, in its title or a comment, so a
  reviewer can map requirements to tests both ways.
- Every `IF … THEN` criterion gets a test of the failure path: the bad
  input, the missing permission, the conflict. These are the tests a team
  forgets.
- If a criterion is ambiguous, check the project's precedent first; if it
  is still unclear, ask the Lead instead of guessing the expected behaviour.

## Prove-It: the test fails first

When a spec changes behaviour, the test task comes **after** the shared
contract and **before** the implementation it proves:

1. Write the test against the contract.
2. Run it and record the red run in your handoff: the command,
   `"status": "failed_before_implementation"`, and the first line of the
   failure. It must fail for the right reason (the behaviour is missing),
   not because of a typo or a broken fixture.
3. Hand off. The implementation task lists yours in `depends_on`.
4. The close-out task reruns the same test and records it green.

A test that passes before the implementation exists proves nothing: fix the
test, not the record.

## Properties for pure logic

When the code under test is pure logic (no I/O) and the rule holds for
**every** input ("no two returned slots overlap", "a round trip gives back
the same value"), a property test checks many generated inputs where an
example test checks one. Use the project's property-testing library if it
has one; do not add one on your own.

- Generators build only valid inputs; invalid input is a separate,
  explicit case.
- Check that the generator is not vacuous: if most inputs produce an empty
  result, the property proves nothing.
- When a property fails, the code or the spec is wrong, never the generator
  by default. Report the seed and the shrunk counterexample; do not weaken
  the property to make it pass.

## Boundaries

- You write in your territory only (the `allowed_paths` of your task).
- When a test fails because of another owner's code, report it with the
  reproduction (the command, the expected and the observed result); do not
  fix their code.
- No skipped test, no known-failure entry and no lowered threshold to reach
  green.
