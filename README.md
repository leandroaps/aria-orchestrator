<p align="center">
  <img src="assets/brand/aria-icon.png" width="160" alt="ARIA">
</p>

# ARIA

**ARIA** (*Á-ri-a*) — **A**gentic **R**easoning and **I**ntelligent **A**utomation.
Agentic SDLC Orchestrator.

**Complexity orchestrated. Simplicity delivered.**
· [aria-orchestrator.dev](https://aria-orchestrator.dev/)

> "Hey Aria, implement this feature."

An aria is a piece of music; ARIA orchestrates the agents that build your
software. It is a Claude Code plugin that drives a project through the SDLC as
a spec-driven orchestration:

intent → spec → plan → **owner approval** → dispatch to role agents →
**evidence-based acceptance** → review → pull request.

Merge and deploy always stay outside its authority.

## Why another skills pack

Skill packs such as [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)
and [mattpocock/skills](https://github.com/mattpocock/skills) teach an agent how
to work well. ARIA also **enforces** the process with code:

- a run state machine that decides which task is ready;
- an approval bound to the plan digest and given by a human click, never by
  typed text;
- territory guards that block writes outside the paths a role owns;
- acceptance of a task only against the observed change, not the agent's
  claim;
- a pre-push gate that runs the checks CI would run.

## Status

Pre-alpha. The repository is being extracted from the orchestrator that runs
[bernardo-pet](https://github.com/leandroaps/bernardo-pet); see
[`docs/plan/0001-extraction.md`](docs/plan/0001-extraction.md). Nothing here is
usable yet.

## Install (once released)

```text
/plugin marketplace add leandroaps/aria-orchestrator
/plugin install aria-orchestrator@aria
```

Enforcement relies on Claude Code hooks. Other agents that read `AGENTS.md`
get the skills as guidance only.

## Configuration

A repository orchestrated by ARIA keeps its project rules in
`aria.config.json`: the agents and the paths each one may write, the reviews
that changes to sensitive paths require, where specs live, and which
external resources a local lock cannot protect, and claims its agents and
skills must not make (`contracts.forbidden`). Runtime state goes in
`.aria/`, which should be git-ignored.

Start from [`templates/aria.config.json`](templates/aria.config.json). Its
`$schema` line gives editors completion and inline errors from
[`schema/aria.config.schema.json`](schema/aria.config.schema.json). Check it
with:

```bash
node bin/aria.mjs validate config          # every problem, with its location
node bin/aria.mjs validate config --json   # for scripts and CI
```

Exit codes: 0 valid, 1 invalid, 2 usage error.

## Command line

`node bin/aria.mjs --help` lists every command. All of them take `--root`
(default: the git top level of the current directory) and `--json`, and
exit 0 when clean, 1 on findings or a refusal, 2 on a usage error. The
checks below are read-only.

| Command | Checks |
|---|---|
| `validate config` | `aria.config.json` |
| `validate spec [<spec>]` | Spec IDs and status agree; every task cites requirements that exist; every requirement is covered |
| `validate graph <spec>` | Owners, dependencies, cycles, territories, and parallel tasks that write the same paths |
| `validate handoff <spec> <file> [--base <ref>]` | A worker's handoff: shape, owner, territory, and with `--base`, the real change |
| `validate run [<run-id>]` | A run's manifest, events and approval provenance |
| `validate contracts` | Agents, skills, `CLAUDE.md` and `AGENTS.md`: skill anatomy, the model policy, read-only agents' tools, preloaded skills, paths that do not exist, and the project's `contracts.forbidden` rules |
| `validate workflows` | The plugin's workflows and the repository's `.claude/workflows/`, against the rules of the workflow runtime; every `agent()` names its model |
| `scope --base <ref> --head <ref>` | Files and specs a change touches, and whether governance files changed |
| `classify (--base/--head \| --files <json>) [--manual <json>]` | Reviews the change requires or recommends, with the reason for each |

Changes to the files that govern the orchestration (`aria.config.json`,
`.claude/` settings, agents, skills and workflows, `CLAUDE.md`, `AGENTS.md`,
CI workflows, `CODEOWNERS`, `package.json`) always require the `security`
reviewer. That list lives in code, so a change cannot remove it by editing
the config.

### Runs

`aria status [<run-id>]` shows a run at a glance: its state, the approval,
the tasks that need attention, the last failure and the next command to
run. Without a run id it shows the most recent run. `--verbose` lists every
task and `--debug` adds the plan digest and paths. A pending or voided
approval and failures show at every level. Colour and symbols come from the
brand tokens; colour follows `NO_COLOR`, `FORCE_COLOR` and whether the
output is a terminal, symbols fall back to ASCII where Unicode is not safe,
and `--json` output never carries an escape code.


`aria run <command>` drives one orchestration run of a spec. Its state lives
in `.aria/runs/<run-id>/`; locks and approval events live in the git common
dir, so every worktree sees them.

| Command | Does |
|---|---|
| `run create <spec>` | Creates a run from the spec's plan; an invalid graph refuses it |
| `run plan <run-id>` | Presents the plan and gives the prefix the owner approves |
| `run status <run-id>` | State, plan digests and whether the approval still holds |
| `run record-approval <run-id> [--event <id>]` | Records the owner's click on the plan |
| `run start <run-id> <task>` | Dispatches a task whose dependencies are accepted |
| `run verify <run-id> <task>` | Runs the task's checks on a snapshot of the current tree |
| `run accept <run-id> <task> <handoff.json>` | Compares the handoff with the real change, runs the checks, accepts or routes a defect |
| `run ready <run-id>` | Each task's state and which can be dispatched now |
| `run fail <run-id> <task> --category <c> --repro <case>` | Records a failure; the third of the same defect blocks the run |
| `run resume <run-id>` | Revalidates every task after an interruption |
| `run recover-lock <key>` | Frees a lock only when its holder provably stopped using it |
| `run cancel <run-id> --reason <text>` | Ends a superseded run and releases its locks |
| `run select <run-id> [--pr <n>]` | Names the run `/loop` follows |
| `run observe [--checks <text>] [--head <sha>]` | One loop tick: `work`, `idle` or `stop`, with the reason |

Only the owner's click on the approval question approves a plan. The
plugin's question hook records it, and `record-approval` accepts only events
written by that hook. `record-approval` and `cancel` refuse a `--root` other
than the repository of the current directory.

## Skills, agents and workflows

The plugin ships the process; the project keeps its stack. Skills hold the
method, agents hold a role, and workflows sequence agents around the run
controller.

| Kind | Name | Does |
|---|---|---|
| Skill | `orchestrate` | The Lead's protocol for a spec: reality check, impact, graph, the owner's approval, dispatch, handoffs, routing, close-out |
| Skill | `spec` | Writing and closing a spec: EARS criteria, `tasks.md` with owners and `task-meta` |
| Skill | `interview` | Confirmed intent before a spec exists, one question at a time |
| Skill | `reality-check` | What the spec claims against what the repository holds |
| Skill | `doubt-review` | A fresh-context reviewer told to disprove one decision |
| Skill | `source-grounding` | Framework decisions grounded in the installed version's docs |
| Skill | `pr-review` | Five axes, a severity scale and a verdict |
| Skill | `debugging`, `deprecation` | Root-cause debugging; removing code without breaking its users |
| Skill | `test`, `security`, `presenter` | The method of each reviewing or testing role |
| Skill | `follow-run` | One `/loop` tick over the selected run |
| Agent | `controller` | Runs the one `aria` command a workflow step gives it |
| Agent | `security`, `test`, `pr`, `presenter` | The core roles; the project's own agents (`backend`, `frontend`…) live in its `.claude/agents/` |
| Workflow | `aria-plan`, `aria-execute`, `aria-review` | Plan and impact, dispatch and accept, closing gates and the final security review |

### Models and tokens

Each step runs on the cheapest model that does it well. The table lives in
[`lib/model-policy.mjs`](lib/model-policy.mjs), and `aria validate
contracts` holds the plugin's agents and skills to it:

| Agent | Model / effort | Why |
|---|---|---|
| `controller` | Haiku / low | runs one given command and returns its JSON |
| `presenter` | Haiku / low | mechanical coherence checks |
| `test`, `pr` | Sonnet / medium | writes tests; reviews a diff |
| `security` | Opus / high | the judgement that blocks or allows |

Skills run on the session's model with a fixed effort: `low` for
`follow-run`, `presenter` and `reality-check`; `high` for `spec`,
`doubt-review` and `security`; `medium` for the rest, `orchestrate`
included.

In the project's own repository, `aria validate contracts` reports an agent
without `model` or `effort`: it would run on the session's, possibly the
most expensive. `aria validate workflows` reports an `agent()` call that
names no model, directly or through a plugin agent. Every workflow returns
the tokens the turn has spent, and `aria-execute` takes a `tokenLimit`
after which it dispatches no new round.

Spec templates live in [`templates/spec/`](templates/spec/). In a
repository with the plugin installed, workflows run as
`/aria-orchestrator:aria-plan` and the loop as
`/loop /aria-orchestrator:follow-run`.

## Hooks

The plugin wires four hooks (`hooks/hooks.json`). They are operational
controls, not a sandbox: `aria run accept` still compares the real change.

| Hook | Event | Does |
|---|---|---|
| `question-hook.mjs` | `PreToolUse`/`PostToolUse` on `AskUserQuestion` | Records the owner's click on the approval question, the only way a plan is approved. Denies a question that arrives with answers already filled in |
| `prompt-hook.mjs` | `UserPromptSubmit` | A typed "approve <prefix>" approves nothing; it is logged so `record-approval` can say why |
| `tool-guard.mjs` | `PreToolUse` on writes, Bash and MCP; `Stop` | Keeps the approval registry and `.git` out of reach, keeps subagents out of run state, and during a task limits each agent to its territory; read-only agents only read. `Stop` asks once to accept or fail a running task |
| `push-gate.mjs` | `PreToolUse` on Bash | Before `git push` of a branch, runs `aria gate` on the pushed worktree: config, changed specs and their graphs, required reviewers |

`aria gate` runs the same checks by hand.

Everything the plugin shows is in English: commands, skills, agents and the
approval question. Another language is used only when the project asks for
it: `"locale": "pt-BR"` in `aria.config.json` switches the approval question
to Brazilian Portuguese. `aria run plan` gives the question as
`approval_question`.

## Development

```bash
npm test                # node:test, no dependencies, including the
                        # end-to-end run in test/e2e.test.mjs
npm run validate:plugin # claude plugin validate --strict
```

The project page at <https://aria-orchestrator.dev> lives in `site/`, a
separate package with its own dependencies (React, Vite, Wrangler):

```bash
cd site && npm install && npm test   # builds dist/ and tests it
```

Phase status on the page comes from `docs/plan/status.json`; update it in
the pull request that lands a phase.

### Pull requests

- Pull requests are opened by the `farofino-bot` GitHub App, never by a
  personal account.
- `main` is protected: merge only through a pull request with the `test`
  check green and an approving review from the code owner (`.github/CODEOWNERS`).
  Force pushes and deletion are blocked, for admins too.

## License

[MIT](LICENSE)
