---
name: security
effort: high
description: >
  Audit a plan, a diff or a repository for security: access control and
  scoping, authentication and sessions, input validation, secrets, the
  orchestration's own controls (approval, territory, evidence) and the CI/CD
  pipeline, reporting each finding with severity and a concrete failure
  scenario. Use when the `security` agent or the Lead needs a security review,
  before dispatching or before closing a high-impact spec.
---

# Security: findings with a scenario, or nothing

This is the method. The project's own security standard, if it has one (a
spec, a threat model, a findings register), is the standard you review
against: find it from `AGENTS.md` or `CLAUDE.md` and read it first. Read the
spec under review before its code: you review against its stated access
model, not your assumption of one.

## Two moments per high-impact spec

- **Before dispatch** (impact analysis of the plan): what data, what new
  surface, who can reach it, what breaks if access control fails, and what
  the plan lets each owner write.
- **Before done** (verification of the integrated change): what shipped
  matches the analysis.

## Checklist

### Access control

- [ ] Every new entry point (route, handler, command, job) applies the
      project's access check, or is on a documented public list.
- [ ] Identity and ownership come from the session, never from the request
      body (`userId`, `role`, an owner field).
- [ ] An object outside the caller's scope is not found (404), not
      forbidden (403), when the project hides existence.
- [ ] Two guards with the same signature are not swapped for each other.

### Input and output

- [ ] Input is validated at the boundary, with the type the code expects; a
      filter value of the wrong type is rejected, not coerced.
- [ ] No string-built query, shell command or path from user input.
- [ ] No secret, token or personal data in logs, errors or responses.

### Secrets and configuration

- [ ] No secret in the repository, in a test fixture or in a log line.
- [ ] Secrets are scoped to the job or environment that needs them.
- [ ] You never read or print an environment file or a private key to
      review it; check names, not values.

### The orchestration's own controls

- [ ] Changes to the files that govern the orchestration (`aria.config.json`,
      the hooks and settings under `.claude/`, agents, skills, workflows,
      `CLAUDE.md`, `AGENTS.md`, CI workflows, `CODEOWNERS`) are deliberate and
      reviewed: they decide what every other agent may do.
- [ ] Nothing gives an approval a path other than the owner's click on the
      approval question.
- [ ] No task's `allowed_paths` is wider than its owner's territory, and no
      read-only agent gains a write tool.
- [ ] Verification commands cannot be edited by the task they verify.

### Pipeline

- [ ] Workflow `permissions:` are minimal; third-party actions are pinned.
- [ ] Untrusted input (a pull request title, a branch name) never reaches a
      shell unquoted.
- [ ] No install or lifecycle script runs next to production credentials.

## Reporting

Rank every finding **Critical, High, Medium or Low**, judged against the
project's real data and exposure, not a demo. Each finding carries:

- the severity;
- `file:line`;
- the requirement or rule it violates;
- a concrete failure scenario: an input and the wrong outcome it produces.

A finding with no scenario is a hunch: verify it or drop it. Prefer
verifying to speculating, and say plainly which findings you confirmed and
which are plausible but unverified.

A **Critical or High** finding blocks dispatch (in the plan review) or done
(in the final review): say so explicitly. Medium and Low either get a task
or become an explicitly accepted risk, recorded where the owner sees it;
never silently dropped.

## Boundaries

- **Read-only.** You report to the Lead, who routes each finding to the
  owner of the path. You never patch another agent's code.
- No destructive verification: no writes to a shared database, no attempts
  against any host that is not the project's local environment.
- Do not invent requirements. If the spec is silent on an access rule,
  check the project's precedent first; if it is still unclear, escalate to
  the Lead.
