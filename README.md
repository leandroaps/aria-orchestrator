<p align="center">
  <img src="assets/brand/aria-icon.png" width="160" alt="ARIA">
</p>

# ARIA

**ARIA** (*Á-ri-a*) — **A**gentic **R**easoning and **I**ntelligent **A**utomation.
Agentic SDLC Orchestrator.

**Complexity orchestrated. Simplicity delivered.**
· [leandroaps.github.io/aria-orchestrator](https://leandroaps.github.io/aria-orchestrator/)

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
external resources a local lock cannot protect. Runtime state goes in
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

`node bin/aria.mjs --help` lists every command. All of them are read-only,
take `--root` (default: the git top level of the current directory) and
`--json`, and exit 0 when clean, 1 on findings, 2 on a usage error.

| Command | Checks |
|---|---|
| `validate config` | `aria.config.json` |
| `validate spec [<spec>]` | Spec IDs and status agree; every task cites requirements that exist; every requirement is covered |
| `validate graph <spec>` | Owners, dependencies, cycles, territories, and parallel tasks that write the same paths |
| `validate handoff <spec> <file> [--base <ref>]` | A worker's handoff: shape, owner, territory, and with `--base`, the real change |
| `validate run [<run-id>]` | A run's manifest, events and approval provenance |
| `scope --base <ref> --head <ref>` | Files and specs a change touches, and whether governance files changed |
| `classify (--base/--head \| --files <json>) [--manual <json>]` | Reviews the change requires or recommends, with the reason for each |

Changes to the files that govern the orchestration (`aria.config.json`,
`.claude/` settings, agents, skills and workflows, `CLAUDE.md`, `AGENTS.md`,
CI workflows, `CODEOWNERS`, `package.json`) always require the `security`
reviewer. That list lives in code, so a change cannot remove it by editing
the config.

## Development

```bash
npm test                # node:test, no dependencies
npm run validate:plugin # claude plugin validate --strict
```

### Pull requests

- Pull requests are opened by the `farofino-bot` GitHub App, never by a
  personal account.
- `main` is protected: merge only through a pull request with the `test`
  check green and an approving review from the code owner (`.github/CODEOWNERS`).
  Force pushes and deletion are blocked, for admins too.

## License

[MIT](LICENSE)
