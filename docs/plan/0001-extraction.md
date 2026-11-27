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
  self-tests (with neutral paths) to `node:test`. Done in one pull request.
  Differences from bernardo-pet:
  - the push gate runs aria's checks in-process (config, changed specs and
    graphs, required reviewers) instead of the project's npm scripts, and
    compares with the remote's default branch;
  - the `pr` agent may run plain `gh` publish and read commands; the
    farofino-bot token wrapper is project-specific and stays in bernardo;
  - read-only auditors may run the `aria` read commands (`validate`,
    `scope`, `classify`, `status`, `run status`, `run ready`);
  - the approval question names the spec by its full directory name and
    exists in `en` and `pt-BR`.
- **P5 — Skills, agents, workflows.** Translate and generalize the process
  skills and the five core agents; rename workflows; spec templates;
  `aria validate contracts` and the workflow commands (`check-workflows`,
  `select`, `observe`).
  Done in one pull request. Differences from bernardo-pet:
  - `check-workflows` is `aria validate workflows`, next to the other read
    checks. It checks the plugin's `workflows/` (the three `aria-*` are
    required) and the repository's `.claude/workflows/`, against the rules
    the workflow page documents: `meta` first and literal, `meta.name` equal
    to the file, phases opened with the titles `meta` lists, no module
    loading, no filesystem, shell or `process`, no clock or randomness, and
    no `.filter(Boolean)`. Prompt text in strings and comments is ignored.
  - `select` and `observe` are `aria run select` and `aria run observe`.
    `observe` stops when the approval no longer holds, not only on the
    run's state. `select` is reserved to the main session.
  - `.claude/loop.md` cannot ship in a plugin; the `follow-run` skill holds
    the tick, run as `/loop /aria-orchestrator:follow-run`.
  - `validate contracts` keeps the generic checks (skill anatomy, read-only
    agents' tools, preloaded skills, dead paths) and adds one: fields Claude
    Code ignores for plugin agents (`hooks`, `mcpServers`, `permissionMode`,
    `initialPrompt`). Bernardo's project rules (false claims, model and
    effort per role, its memory-file rules) become `contracts.forbidden` in
    `aria.config.json`, or stay in bernardo.
  - `test` and `security` are new, stack-neutral skills; bernardo keeps its
    Playwright and Next.js checklists. `orchestrate` drops bernardo's
    roadmap table and tracking-issue steps.
  - The workflows cannot read `aria.config.json`, so `aria-execute` accepts
    any plain agent name as an owner except the control agents; `aria run
    accept` still checks the handoff's agent and the real change.
    `aria-review` takes the project's closing commands as `args.checks`.
  - The tool guard maps `aria-orchestrator:<agent>` to `<agent>`. Another
    plugin's agent keeps its scoped name and has no role or territory.
  To check in P7: whether a hook's `agent_type` carries the plugin-scoped
  name; whether a workflow's `agentType` and an agent's `skills` accept
  `aria-orchestrator:<name>`; and the `Workflow` tool's name for a plugin
  workflow.
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

Answers, checked on 2026-11-27 against the Claude Code docs (`hooks`,
`hooks-guide`, `plugins-reference` at code.claude.com). P7 confirms them in
a real session.

1. **Both run, in parallel; order is not documented.** "When a plugin is
   enabled, its hooks merge with your user and project hooks", and "its
   matching hooks run in parallel". For `PreToolUse`, conflicting decisions
   resolve as deny > defer > ask > allow, and a hook's `allow` never
   overrides settings deny rules. Consequence for P4: no guard may rely on
   running before or after another hook; each one decides on its own input,
   and a deny from any of them wins.
2. **Plugins ship workflows** in `workflows/` (manifest key `workflows`). No
   `aria init` copy is needed for them. `.claude/workflows` itself is not
   mentioned; the workflow page is read in P5. Read in P5
   (`workflows` page): a plugin workflow runs as
   `/aria-orchestrator:<meta.name>`; the script only coordinates agents
   (no filesystem, shell or module loading); `Date.now()`, `Math.random()`
   and `new Date()` throw; `meta` must be a literal and open the file. The
   page documents `agent()` options `schema`, `label` and `stallMs`, not
   `agentType`, which bernardo uses and P7 checks.
3. **`bin/` is on the Bash tool's `PATH`** while the plugin is enabled, so
   Claude runs `aria` as a bare command. Hook commands get
   `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` and `CLAUDE_PROJECT_DIR`; those
   are not set for commands run through the Bash tool. Hooks call
   `node "${CLAUDE_PLUGIN_ROOT}/bin/aria.mjs"`, never the bare name. `bin/`
   blocks installation on claude.ai and Cowork, which v0.1 does not target.
4. **`PreToolUse` input is documented:** `tool_input.questions[]` with
   `question`, `header`, `options[{label, description}]`, `multiSelect`, and
   an optional `answers` map (question text → label) that Claude can fill
   so that no question is shown. `tool_use_id` comes with `PreToolUse` and
   `PostToolUse`. **The `PostToolUse` `tool_response` for `AskUserQuestion`
   is not documented.** bernardo-pet observed (Claude Code 2.1.302) that it
   holds `{questions, answers, annotations}`, and that a model-filled
   `answers` arrives there exactly like a click. So the question hook keeps
   bernardo's design: `PreToolUse` denies any `tool_input` key besides
   `questions` and writes a pre-check mark keyed by session and
   `tool_use_id`; `PostToolUse` records an approval only when that mark
   exists. P7 re-checks the response shape on the installed version.

## Out of scope for v0.1

Stack profiles (backend/frontend/devops/sre), `agent-metrics`, the specs
explorer UI, GitHub issue/PR sync automation, support for agents other than
Claude Code (they get `AGENTS.md` + skills as guidance only, documented as
such).

## Provenance

Fresh repository, no history import: Bernardo's history mixes app and
orchestrator commits. The README credits `bernardo-pet` as the origin and the
first commit records the source SHA above.
