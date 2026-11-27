# Plan 0001 — Extract the Bernardo orchestrator into aria-orchestrator

Status: Draft (awaiting owner approval)
Date: 2026-11-27
Source: `bernardo-pet` @ `09dc6acb` (branch `developer`)

## Goal

Turn the spec-driven orchestration model that runs `bernardo-pet` into a
reusable Claude Code plugin, **aria-orchestrator**, that drives a project
through the SDLC: intent → spec → plan → owner approval → dispatch to
role agents → evidence-based acceptance → review → PR. Merge and deploy stay
outside its authority.

What sets it apart from prompt-only skill packs (addyosmani/agent-skills,
mattpocock/skills): the rules are **enforced by code** — a run state machine,
an approval bound to the plan digest and given by a human click, territory
guards on every write, and a pre-push gate — not only described in Markdown.

## Name

**ARIA** (*Á-ri-a*): **A**gentic **R**easoning and **I**ntelligent
**A**utomation. Short, easy to say ("Hey Aria, implement this feature."), and
an aria is a piece of music, so the name nods to orchestration. The README
opens with this.

## Decisions already taken

| Topic | Decision |
|---|---|
| Language | English for skills, agents, docs and code; prompt/approval locale configurable (`en`, `pt-BR`) |
| Distribution | Claude Code plugin + marketplace (`.claude-plugin/`), scripts shipped inside the plugin |
| v0.1 scope | Generic core only (engine, approval, guards, validators, process skills, core agents) |
| Bernardo migration | Only after v0.1 is validated in another repo; done as a high-impact spec inside `bernardo-pet` |

## Inventory (what comes from bernardo-pet)

Measured on disk; "coupling" = lines mentioning Bernardo's stack or identity.

### Engine (≈ 4.9k lines, low coupling)

| Source | Lines | Coupling to remove |
|---|---|---|
| `scripts/agent-run.mjs` | 1259 | `REQUIRED_WORKFLOWS = ["bernardo-*"]` |
| `scripts/lib/agent-run-state.mjs` | 963 | `EXTERNAL_RESOURCE_PATTERN` (neon/cloudflare) |
| `scripts/lib/agent-run-evidence.mjs` | 544 | `GENERATED_INPUTS = ["cloudflare-env.d.ts"]`, OpenNext note |
| `scripts/lib/agent-approval-registry.mjs` | 412 | state directory location |
| `scripts/lib/execution-graph.mjs` | 161 | none (comments only) |
| `scripts/lib/spec-parsing.mjs` | 230 | spec folder convention |
| `scripts/lib/agent-config.mjs` | 141 | config file name |

### Hooks (≈ 2.3k lines, medium coupling)

| Source | Lines | Coupling to remove |
|---|---|---|
| `scripts/agent-tool-guard.mjs` | 1163 | `farofino-bot` token command allowlist; self-tests use `src/lib`, `mcp__neon__*` |
| `scripts/agent-push-gate.mjs` | 843 | npm/Playwright commands of the CI `scope` job |
| `scripts/agent-question-hook.mjs` | 255 | pt-BR approval label `Sim, aprovo <prefix>` |
| `scripts/agent-prompt-hook.mjs` | 57 | none |

### Validators and scope (≈ 2.3k lines)

| Source | Lines | Coupling to remove |
|---|---|---|
| `scripts/validate-agent-contracts.mjs` | 1083 | Bernardo-specific contract phrases (farofino, neon-proxy, workflow names) — split into generic core + project rules |
| `scripts/changed-scope.mjs` | 216 | path patterns (`drizzle/`, `wrangler.jsonc`, `e2e/…`) |
| `scripts/classify-impact.mjs` | 207 | high-impact list |
| `scripts/validate-spec.mjs` / `validate-task-graph.mjs` / `validate-handoff.mjs` / `validate-agent-run.mjs` / `validate-changed.mjs` | 755 | spec location only |
| `scripts/list-pending-specs.mjs` | 288 | `specs/roadmap.md` table format |
| `scripts/agent-metrics.mjs` | 810 | deferred to v0.2 |

### Claude Code surface

- Skills (process, generic after cleanup): `interview`, `spec`,
  `reality-check`, `orchestrate`, `doubt-review`, `source-grounding`,
  `pr-review`, `debugging`, `deprecation`, `presenter`.
- Skills left in Bernardo (stack-specific): `backend`, `frontend`,
  `admin-resource`, `devops`, `sre`, `performance`, `accessibility`,
  `run-app`, `test`, `security` (the last two get a generic version in aria,
  the stack checklists stay in the project).
- Agents for the core: `controller`, `security`, `test`, `pr`, `presenter`.
  The Lead stays the main session (no orchestrator subagent — Bernardo
  spec 0051 R3.1 rationale carries over).
- Workflows: `bernardo-plan.js`, `bernardo-execute.js`, `bernardo-review.js`
  → `aria-plan`, `aria-execute`, `aria-review`, keeping the manual-protocol
  fallback when the `agent()/pipeline()` runtime is absent.
- `.claude/loop.md` → plugin-provided loop instructions for `/loop`.

## Target layout

```
aria-orchestrator/
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json
├── skills/<name>/SKILL.md
├── agents/*.md
├── hooks/hooks.json            # uses ${CLAUDE_PLUGIN_ROOT}
├── workflows/aria-*.js
├── bin/aria.mjs                # single CLI: run, validate, scope, gate
├── lib/                        # engine modules
├── locales/{en,pt-BR}.json     # approval label, question text
├── schema/aria.config.schema.json
├── templates/spec/{requirements,design,tasks}.md
├── templates/aria.config.json  # starter config for a consumer repo
├── test/                       # node:test, plus a fixture git repo
├── docs/
└── README.md, LICENSE, CHANGELOG.md
```

Consumer repo gets `aria.config.json` and keeps runtime state under `.aria/`
(replaces Bernardo's `.agent/`), git-ignored.

## `aria.config.json` (replaces hard-coded values)

- `agents`: role → `mode`, `category`, `allowedPaths`, `defaultVerification`
  (same shape as Bernardo's `agents.config.json`).
- `specs`: directory, roadmap file, ID pattern.
- `impact.highImpactPaths`: project list, **added to** a fixed list the
  plugin owns (its own config, hooks, `AGENTS.md`/`CLAUDE.md`, agent and
  skill files). The fixed list never comes from config — Bernardo's bootstrap
  rule (spec 0069 R7.7) carries over.
- `gate.prePush`: commands the pre-push gate runs.
- `evidence.generatedInputs`, `run.externalResources`: replace the
  Cloudflare/Neon constants.
- `pr.identity`: `user` (default) or `github-app` with the token command; the
  empty-token guard stays mandatory when `github-app` is set.
- `locale`: `en` | `pt-BR`.

P2 ships the keys the engine reads today: `version`, `agents`,
`impactRules`, `specs.dir`, `evidence.generatedInputs`,
`run.externalResources` and `locale`. Unknown keys are errors, so a typo
never passes silently. The others (`specs` roadmap and ID pattern,
`impact.highImpactPaths`, `gate.prePush`, `pr.identity`) are added to the
schema and the loader in the phase that builds what reads them (P3/P4), so
the config never accepts a setting that does nothing.

## Phases

Each phase ends green on `npm test` in aria before the next starts.

- **P0 — Scaffold.** `package.json` (Node: always the active LTS, today 24,
  pinned in `.nvmrc`; no runtime deps),
  plugin/marketplace manifests, README skeleton, license, `node:test` setup,
  GitHub Actions running the tests.
- **P1 — Engine.** Copy `lib/` modules, strip Bernardo spec references from
  comments, replace constants with config reads, `.agent/` → `.aria/`. Port
  the engine self-tests to `node:test`.
- **P2 — Config.** JSON Schema, loader with clear errors, starter template,
  `aria validate config`.
- **P3 — CLI.** `bin/aria.mjs`, in two pull requests:
  - **P3.1** — `validate {spec,graph,handoff,run}`, `scope`, `classify`.
    The checks live in `lib/validate.mjs` and `lib/impact.mjs`, so hooks and
    the run controller call the same code.
  - **P3.2** — the run commands that map today's `agent-run` (`create`,
    `plan`, `status`, `record-approval`, `start`, `verify`, `accept`,
    `ready`, `fail`, `resume`, `recover-lock`, `cancel`), with the terminal
    layer of plan 0002 (B2) for `aria status`. Two pull requests:
    - **P3.2a** — `aria run <command>`, with plain and `--json` output. The
      logic lives in `lib/run-controller.mjs`. `record-approval` accepts
      only events whose digest matches the plugin's own
      `hooks/question-hook.mjs`, so it refuses until P4 ships that hook.
      `record-approval` and `cancel` refuse a `--root` other than the
      current repository.
    - **P3.2b** — the terminal layer and `aria status`: the run summary
      with the next step, which `agent-run status --brief` gave.
  - Each part moves to the phase that builds what it reads. `validate
    contracts` checks agents and skills, so it moves to P5. `gate` is the
    pre-push gate a hook triggers, so it moves to P4. So do
    `check-workflows`, `select` and `observe`, which read the workflows,
    to P5.
- **P4 — Hooks.** Tool guard, question hook, prompt hook, push gate (with
  `aria gate`) wired in `hooks/hooks.json`; approval label from `locales/`. Port the tool-guard
  self-tests (with neutral paths) to `node:test`.
- **P5 — Skills, agents, workflows.** Translate and generalize the process
  skills and the five core agents; rename workflows; spec templates;
  `aria validate contracts` and the workflow commands (`check-workflows`,
  `select`, `observe`).
- **P6 — End-to-end test.** A fixture repo created in a temp dir runs a full
  run: plan → approval → dispatch → accept → review, asserting the guards
  block out-of-territory writes and unapproved runs.
- **P7 — Real validation.** Install the plugin from the local marketplace in a
  throwaway repo and run one real spec with Claude Code; record what broke in
  `docs/validation/0001.md`. v0.1.0 is tagged only after this.
- **P8 — Bernardo migration (separate, later).** A high-impact spec in
  `bernardo-pet` (security twice, owner click) swaps its scripts for the
  plugin and keeps only config and stack agents. Not part of this plan.

## To verify before P4/P5 (Claude Code behavior, not assumed)

1. Whether plugin hooks and project hooks both run, and in what order, when
   both are present.
2. Whether a plugin can ship workflows (`.claude/workflows`) or they must be
   copied into the consumer repo by an `aria init` command.
3. Whether `bin/` of a plugin is on `PATH` for Bash calls, or hooks must call
   `node ${CLAUDE_PLUGIN_ROOT}/bin/aria.mjs`.
4. The `AskUserQuestion` hook payload shape the question hook relies on.

## Out of scope for v0.1

Stack profiles (backend/frontend/devops/sre), `agent-metrics`, the specs
explorer UI, GitHub issue/PR sync automation, support for agents other than
Claude Code (they get `AGENTS.md` + skills as guidance only, documented as
such).

## Provenance

Fresh repository, no history import: Bernardo's history mixes app and
orchestrator commits. The README credits `bernardo-pet` as the origin and the
first commit records the source SHA above.
