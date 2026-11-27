# Tasks: <title>

**Spec ID:** NNNN
**Status:** Draft

<!-- T1..Tn in execution order. Each task names its owner (an agent in
     aria.config.json, or `lead` for the main session), cites the R#.# it
     satisfies, and carries a task-meta block: depends_on, allowed_paths
     (inside the owner's territory, or [] for no writes) and verification
     (the command that proves the task is done, decided before the code).
     A test that proves a behaviour comes before the implementation it
     proves, and fails first. Check with:
       aria validate spec NNNN-slug
       aria validate graph NNNN-slug -->

- [ ] **T1** Write the failing test for R1.1 and R1.2 (`test`) → R1.1, R1.2

  The test fails before T2 and passes after it; record the red run in the
  handoff.

  ```yaml task-meta
  id: T1
  depends_on: []
  allowed_paths:
    - e2e/**
  verification:
    - npm test
  ```

- [ ] **T2** Implement R1.1 and R1.2 (`backend`) → R1.1, R1.2

  ```yaml task-meta
  id: T2
  depends_on: [T1]
  allowed_paths:
    - src/lib/**
  verification:
    - npm test
  ```

## Done criteria

- [ ] Every R#.# verified, or listed as unverified with the reason.
- [ ] `Status:` updated in requirements.md, design.md and tasks.md to what
      the code actually does.
- [ ] The draft pull request marked ready for review.
