#!/usr/bin/env node
// The `aria` command line. Plan 0001 P3.1: validators, scope and impact
// classification. P3.2: the run commands (`aria run <command>`).
//
// Exit codes: 0 ok, 1 findings or a refused check, 2 usage error (unknown
// command or spec, missing argument, unreadable input).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { RUN_ID_PATTERN, scrubGitLocationEnv } from "../lib/approval-registry.mjs";
import { CONFIG_FILE, ConfigError, loadConfig, normalizeConfig } from "../lib/config.mjs";
import { buildExecutionGraph, listSpecDirs, resolveSpec } from "../lib/execution-graph.mjs";
import { ScopeError, changedScope, classifyImpact } from "../lib/impact.mjs";
import {
	TASK_ID_PATTERN,
	acceptCommand,
	cancelCommand,
	createCommand,
	failCommand,
	planCommand,
	readyCommand,
	recordApprovalCommand,
	recoverLockCommand,
	resumeCommand,
	latestRunId,
	startCommand,
	statusCommand,
	summaryCommand,
	verifyCommand,
	selectCommand,
	observeCommand,
} from "../lib/run-controller.mjs";
import { renderRunStatus } from "../lib/experience/run-status.mjs";
import { manualGate } from "../lib/push-gate.mjs";
import { REQUIRED_WORKFLOWS, workflowProblems } from "../lib/workflow-check.mjs";
import { contractFindings } from "../lib/contracts.mjs";
import { createTheme, detectTerminal } from "../lib/experience/terminal.mjs";
import { compareHandoffToDelta, hardenedGit, snapshotTree, treeDelta } from "../lib/run-evidence.mjs";
import { DEFECT_CATEGORIES, LOCK_KEY_PATTERN } from "../lib/run-state.mjs";
import {
	graphFindings,
	handoffOwnershipFindings,
	handoffShapeFindings,
	listRunIds,
	runFindings,
	specCategory,
	specFindings,
} from "../lib/validate.mjs";

const USAGE = `Usage: aria <command> [options]

Commands:
  validate config                       Check ${CONFIG_FILE}
  validate spec [<spec>]                Check one spec, or every spec
  validate graph <spec>                 Check a spec's execution graph
  validate handoff <spec> <file.json>   Check a worker's handoff
           [--base <ref>]               ...and compare it with the real change
  validate run [<run-id>]               Check one run, or every run
  validate contracts                    Check agents, skills, CLAUDE.md and
                                        AGENTS.md, plus contracts.forbidden
  validate workflows                    Check the plugin's workflows and the
                                        repository's .claude/workflows/
  scope --base <ref> --head <ref>       Files and specs a change touches
  classify --base <ref> --head <ref>    Reviews a change requires
           [--files <list.json>]        ...from a JSON list of files instead
           [--manual <reviewers.json>]  ...plus {"required": [...]} from the spec

Gate:
  gate                                  The checks a push must pass: config,
                                        changed specs and graphs, reviewers

Status:
  status [<run-id>]                     A run at a glance and its next step
                                        (default: the most recent run)
           [--verbose | --debug]        ...every task, or also digests and paths

Run commands (one orchestration run of a spec):
  run create <spec>                     Create a run from the spec's plan
  run plan <run-id>                     Present the plan for the owner's approval
  run status <run-id>                   State, plan digests and approval
  run record-approval <run-id>          Record the owner's click on the plan
           [--event <event-id>]         ...naming the approval event
  run start <run-id> <task>             Dispatch a ready task
  run verify <run-id> <task>            Run the task's checks on the current tree
  run accept <run-id> <task> <file.json>  Accept the worker's handoff, or refuse it
  run ready <run-id>                    Tasks and which can be dispatched now
  run fail <run-id> <task> --category <c> --repro <case> [--requirement <R#.#>]
                                        Record a failure; the third one blocks
  run resume <run-id>                   Revalidate a run after an interruption
  run recover-lock <key>                Free a lock whose holder is gone
  run cancel <run-id> --reason <text>   End a superseded run
  run select <run-id> [--pr <n>]        Name the run /loop follows
  run observe [--checks <text>]         One loop tick: work, idle or stop
           [--head <sha>]               ...for this head (default: HEAD)

Options:
  --root <dir>      Repository root (default: the git top level of the
                    current directory)
  --json            Machine-readable output, no colour or decoration
                    (colour follows NO_COLOR, FORCE_COLOR and the terminal)
  -h, --help        Show this help

Exit codes: 0 ok, 1 findings, 2 usage error.`;

class UsageError extends Error {}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

function readJsonFile(path, label) {
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		throw new UsageError(`cannot read ${label} "${path}": ${error.code ?? error.message}`);
	}
	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new UsageError(`${label} "${path}" is not valid JSON: ${error.message}`);
	}
}

function specsDirOf(ctx) {
	const dir = join(ctx.root, ctx.config().specs.dir);
	if (!existsSync(dir)) throw new UsageError(`no ${ctx.config().specs.dir}/ directory in ${ctx.root}`);
	return dir;
}

// The graph comes from tasks.md; a draft spec without one has no graph yet.
function graphOf(ctx, name) {
	const specsDir = specsDirOf(ctx);
	if (!existsSync(join(specsDir, name, "tasks.md"))) {
		throw new UsageError(`${name} has no tasks.md yet, so it has no execution graph`);
	}
	return buildExecutionGraph(specsDir, name, ctx.config());
}

function resolveSpecName(ctx, arg) {
	const { name, matches } = resolveSpec(specsDirOf(ctx), arg);
	if (name) return name;
	throw new UsageError(
		matches.length === 0
			? `no spec matches "${arg}" in ${ctx.config().specs.dir}/`
			: `"${arg}" matches several specs: ${matches.join(", ")}`,
	);
}

// Prints findings (and info lines) and returns the exit code.
function report(ctx, { subject, findings, info = [], extra = {} }) {
	if (ctx.json) {
		ctx.out.stdout(JSON.stringify({ ok: findings.length === 0, ...extra, findings, info }));
	} else {
		for (const line of info) ctx.out.stdout(`  info  ${line}`);
		for (const line of findings) ctx.out.stdout(`  fail  ${line}`);
		ctx.out.stdout(`${subject}: ${plural(findings.length, "finding")}.`);
	}
	return findings.length === 0 ? 0 : 1;
}

// --- Commands ------------------------------------------------------------------

function validateConfig(ctx) {
	const config = ctx.config();
	const agents = Object.values(config.agents);
	const writers = agents.filter((agent) => agent.mode === "write").length;
	const summary = {
		agents: agents.length,
		writeAgents: writers,
		readOnlyAgents: agents.length - writers,
		impactRules: config.impactRules.length,
		specsDir: config.specs.dir,
		locale: config.locale,
	};
	if (ctx.json) {
		ctx.out.stdout(JSON.stringify({ ok: true, file: CONFIG_FILE, summary }));
	} else {
		ctx.out.stdout(
			`${CONFIG_FILE} is valid: ${plural(summary.agents, "agent")} ` +
				`(${summary.writeAgents} write, ${summary.readOnlyAgents} read-only), ` +
				`${plural(summary.impactRules, "impact rule")}, specs in ${summary.specsDir}/, ` +
				`locale ${summary.locale}.`,
		);
	}
	return 0;
}

function validateSpec(ctx, [arg]) {
	const specsDir = specsDirOf(ctx);
	const names = arg ? [resolveSpecName(ctx, arg)] : listSpecDirs(specsDir);
	const findings = [];
	const info = [];
	for (const name of names) {
		const result = specFindings(specsDir, name);
		findings.push(...result.findings);
		info.push(...result.info);
	}
	return report(ctx, { subject: plural(names.length, "spec"), findings, info, extra: { specs: names } });
}

function validateGraph(ctx, [arg]) {
	const name = resolveSpecName(ctx, arg);
	const specsDir = specsDirOf(ctx);
	if (specCategory(specsDir, name) === "Superseded") {
		const info = [`${name}: Status Superseded; graph not checked`];
		return report(ctx, { subject: name, findings: [], info, extra: { spec: name, tasks: 0 } });
	}
	const graph = graphOf(ctx, name);
	const findings = graphFindings(graph, ctx.config());
	return report(ctx, {
		subject: `${name}, ${plural(graph.tasks.length, "task")}`,
		findings,
		extra: { spec: name, tasks: graph.tasks.length },
	});
}

function validateHandoff(ctx, [arg, file]) {
	const name = resolveSpecName(ctx, arg);
	const handoff = readJsonFile(resolve(file), "handoff");
	const graph = graphOf(ctx, name);
	const findings = handoffShapeFindings(handoff);
	if (typeof handoff === "object" && handoff !== null && !Array.isArray(handoff)) {
		findings.push(...handoffOwnershipFindings(handoff, graph));
		const task = graph.tasks.find((candidate) => candidate.id === handoff.task);
		if (ctx.options.base && task) {
			let baseTree;
			try {
				baseTree = hardenedGit(ctx.root, ["rev-parse", "--verify", `${ctx.options.base}^{tree}`]).trim();
			} catch {
				throw new UsageError(`--base "${ctx.options.base}" is not a commit or tree`);
			}
			const delta = treeDelta(ctx.root, baseTree, snapshotTree(ctx.root));
			findings.push(...compareHandoffToDelta(handoff, delta, task));
		}
	}
	return report(ctx, { subject: file, findings, extra: { spec: name, task: handoff?.task ?? null } });
}

function validateRun(ctx, [runId]) {
	const runIds = runId ? [runId] : listRunIds(ctx.root);
	const findings = runIds.flatMap((id) => runFindings(ctx.root, id).map((finding) => `${id}: ${finding}`));
	return report(ctx, { subject: plural(runIds.length, "run"), findings, extra: { runs: runIds } });
}

// The files that instruct the agents. The config is optional here: without
// one, only the checks that need no project rule run (the plugin itself).
function validateContracts(ctx) {
	const config = existsSync(join(ctx.root, CONFIG_FILE)) ? ctx.config() : normalizeConfig({ version: 1, agents: {} });
	const found = contractFindings(ctx.root, config, { pluginRoot: ctx.env.pluginRoot });
	const findings = found.map(({ file, line, message }) => `${file}${line ? `:${line}` : ""}: ${message}`);
	return report(ctx, { subject: plural(found.files.length, "file"), findings, extra: { files: found.files } });
}

// The plugin's workflows (the required set must be there) and the
// repository's own `.claude/workflows/`.
function validateWorkflows(ctx) {
	const sources = [];
	const pluginDir = join(ctx.env.pluginRoot, "workflows");
	const shipped = new Set(REQUIRED_WORKFLOWS);
	for (const file of existsSync(pluginDir) ? readdirSync(pluginDir) : []) {
		if (file.endsWith(".js")) shipped.add(file.slice(0, -3));
	}
	for (const name of [...shipped].sort()) sources.push([`workflows/${name}.js`, name, join(pluginDir, `${name}.js`)]);
	const ownDir = join(ctx.root, ".claude", "workflows");
	for (const file of existsSync(ownDir) ? readdirSync(ownDir).sort() : []) {
		if (file.endsWith(".js")) sources.push([`.claude/workflows/${file}`, file.slice(0, -3), join(ownDir, file)]);
	}
	const workflows = {};
	for (const [label, name, path] of sources) {
		workflows[label] = existsSync(path) ? workflowProblems(name, readFileSync(path, "utf8")) : ["file missing"];
	}
	const findings = Object.entries(workflows).flatMap(([label, problems]) => problems.map((problem) => `${label}: ${problem}`));
	return report(ctx, { subject: plural(sources.length, "workflow"), findings, extra: { workflows } });
}

function scope(ctx) {
	const result = changedScope(ctx.root, ctx.options, ctx.config());
	if (ctx.json) {
		ctx.out.stdout(JSON.stringify(result));
	} else {
		for (const file of result.files) ctx.out.stdout(`  ${file}`);
		ctx.out.stdout(
			`${plural(result.files.length, "file")} changed since ${result.base.slice(0, 12)}` +
				`; specs: ${result.specs.join(", ") || "none"}` +
				`; governance files changed: ${result.governanceChanged ? "yes" : "no"}.`,
		);
	}
	return 0;
}

function classify(ctx) {
	const { files: filesPath, manual: manualPath } = ctx.options;
	let files;
	if (filesPath) {
		files = readJsonFile(resolve(filesPath), "--files");
		if (!Array.isArray(files) || files.some((file) => typeof file !== "string")) {
			throw new UsageError("--files must hold a JSON array of strings");
		}
	} else {
		files = changedScope(ctx.root, ctx.options, ctx.config()).files;
	}
	let manual = [];
	if (manualPath) {
		manual = readJsonFile(resolve(manualPath), "--manual")?.required;
		if (!Array.isArray(manual) || manual.some((agent) => typeof agent !== "string")) {
			throw new UsageError('--manual must hold {"required": ["agent", ...]}');
		}
	}
	const result = classifyImpact(files, ctx.config(), manual);
	if (ctx.json) {
		ctx.out.stdout(JSON.stringify(result));
	} else {
		for (const reason of result.reasons) {
			const where = reason.files.length > 0 ? `: ${reason.files.join(", ")}` : "";
			ctx.out.stdout(`  ${reason.agent} (${reason.rule})${where}`);
		}
		ctx.out.stdout(
			`required: ${result.required.join(", ") || "none"}; recommended: ${result.recommended.join(", ") || "none"}.`,
		);
		if (result.undeclared.length > 0) {
			ctx.out.stdout(`not declared in ${CONFIG_FILE}: ${result.undeclared.join(", ")}.`);
		}
	}
	// A required reviewer that cannot be dispatched blocks the change.
	return result.undeclared.length === 0 ? 0 : 1;
}

// --- Run commands ----------------------------------------------------------------

const list = (items) => (items.length > 0 ? items.join(", ") : "none");

// A refusal by the run contract (an Error from the controller) exits 1 with
// its message; usage and config errors keep their own handling in `main`.
function runCommand(ctx, execute, render) {
	let result;
	try {
		result = execute();
	} catch (error) {
		if (error instanceof UsageError || error instanceof ConfigError) throw error;
		if (ctx.json) {
			ctx.out.stdout(JSON.stringify({ ok: false, error: error.message, problems: error.problems }));
		} else {
			ctx.out.stderr(`aria ${ctx.command}: ${error.message}`);
			for (const problem of error.problems ?? []) ctx.out.stderr(`  - ${problem}`);
		}
		return 1;
	}
	if (ctx.json) ctx.out.stdout(JSON.stringify(result));
	else for (const line of render(result)) ctx.out.stdout(line);
	return result.ok === false ? 1 : 0;
}

// An approval and a cancellation only act on the repository the command runs
// in: `--root` pointing anywhere else is refused.
function requireOwnCheckout(ctx) {
	if (realpathSync(ctx.root) !== realpathSync(gitTopLevel(ctx.cwd))) {
		throw new Error(`--root points at another repository; ${ctx.command} only acts on the one of the current directory`);
	}
}

function checkLines(results) {
	const lines = [];
	for (const result of results) {
		lines.push(`  ${result.passed ? "pass" : "fail"}  ${result.command}`);
		if (!result.passed) {
			if (result.error) lines.push(`        ${result.error}`);
			for (const line of (result.output_tail ?? "").split("\n").filter(Boolean)) lines.push(`        ${line}`);
		}
	}
	return lines;
}

function runCreate(ctx, [arg]) {
	const spec = resolveSpecName(ctx, arg);
	return runCommand(ctx, () => createCommand(ctx.root, { spec }), ({ run }) => [
		`Run ${run.run_id} created for ${run.spec}: ${run.state}.`,
		`Next: aria run plan ${run.run_id}`,
	]);
}

function runPlan(ctx, [runId]) {
	return runCommand(ctx, () => planCommand(ctx.root, { runId }), (plan) => [
		...plan.tasks.map(
			(task) =>
				`  ${task.id}  ${task.owner}  depends on: ${list(task.depends_on)}  paths: ${list(task.allowed_paths)}`,
		),
		`Run ${runId} (${plan.spec}): ${plan.state}, approval prefix ${plan.approval_prefix}.`,
		`Ask the owner with AskUserQuestion, exactly: header "${plan.approval_question.header}", question "${plan.approval_question.question}", options ${plan.approval_question.options.map((option) => `"${option.label}" (${option.description})`).join(" and ")}. Use --json for the exact object.`,
		`Only their click approves; then run "aria run record-approval ${runId}".`,
	]);
}

function runStatus(ctx, [runId]) {
	return runCommand(ctx, () => statusCommand(ctx.root, { runId }), (status) => {
		const lines = [`Run ${runId} (${status.spec}): ${status.state}`];
		if (!status.approval) lines.push("approval: none");
		else if (status.approval.valid) lines.push(`approval: valid (event ${status.approval.event_id})`);
		else lines.push(`approval: not valid — ${status.approval.reasons.join("; ")}`);
		if (status.plan_digest_current !== status.plan_digest_recorded) {
			lines.push("plan: changed since it was last recorded; present it again");
		}
		if (status.invalid_event_lines > 0) {
			lines.push(`events: ${plural(status.invalid_event_lines, "unreadable line")}`);
		}
		return lines;
	});
}

function runRecordApproval(ctx, [runId]) {
	return runCommand(
		ctx,
		() => {
			requireOwnCheckout(ctx);
			return recordApprovalCommand(ctx.root, { runId, eventId: ctx.options.event }, ctx.env);
		},
		(result) => [`Run ${runId}: ${result.state} (event ${result.approval.event_id}).`],
	);
}

function runStart(ctx, [runId, taskId]) {
	return runCommand(ctx, () => startCommand(ctx.root, { runId, taskId }), (result) => [
		`${taskId} started in run ${runId}, attempt ${result.attempt}.`,
	]);
}

function runVerify(ctx, [runId, taskId]) {
	return runCommand(ctx, () => verifyCommand(ctx.root, { runId, taskId }), (result) => [
		...checkLines(result.results),
		`${taskId}: verification ${result.passed ? "passed" : "failed"}.`,
	]);
}

function runAccept(ctx, [runId, taskId, file]) {
	const handoff = readJsonFile(resolve(ctx.cwd, file), "handoff");
	if (typeof handoff !== "object" || handoff === null || Array.isArray(handoff)) {
		throw new UsageError(`handoff "${file}" must hold a JSON object`);
	}
	return runCommand(ctx, () => acceptCommand(ctx.root, { runId, taskId, handoff }), (result) => {
		const lines = [
			...result.delta.map((path) => `  changed  ${path}`),
			...result.findings.map((finding) => `  fail  ${finding}`),
			...checkLines((result.verification?.results ?? []).filter((check) => !check.passed)),
		];
		if (result.ok) lines.push(`${taskId} accepted: ${plural(result.delta.length, "file")} changed.`);
		else {
			lines.push(
				`${taskId} refused: ${plural(result.findings.length, "finding")}; ` +
					`${result.routing.decision}: ${result.routing.reason}.`,
			);
		}
		return lines;
	});
}

function runReady(ctx, [runId]) {
	return runCommand(ctx, () => readyCommand(ctx.root, { runId }), (result) => [
		...result.tasks.map((task) => {
			const why = [...task.blockers, ...task.conflicts];
			if (task.defect_blocked) why.push("attempt limit reached");
			return `  ${task.id}  ${task.state}${why.length > 0 ? `  (blocked: ${why.join("; ")})` : ""}`;
		}),
		`Run ${runId}: ${result.state}; dispatchable: ${list(result.dispatchable)}.`,
	]);
}

function runSelect(ctx, [runId]) {
	const pr = ctx.options.pr === undefined ? null : Number(ctx.options.pr);
	return runCommand(ctx, () => selectCommand(ctx.root, { runId, pr }), ({ target }) => [
		`The loop follows run ${target.run_id} (spec ${target.spec}, branch ${target.branch}${target.pr ? `, PR #${target.pr}` : ""}).`,
	]);
}

function runObserve(ctx) {
	const { head = null, checks = "unknown" } = ctx.options;
	return runCommand(ctx, () => observeCommand(ctx.root, { head, checks }), (result) => [
		`${result.action}: ${result.reason}`,
		...(result.dispatchable?.length > 0 ? [`Dispatchable: ${list(result.dispatchable)}.`] : []),
	]);
}

function runFail(ctx, [runId, taskId]) {
	const { category, repro: reproduction, requirement } = ctx.options;
	return runCommand(
		ctx,
		() => failCommand(ctx.root, { runId, taskId, category, reproduction, requirement }),
		({ routing }) => [`${taskId} failed in run ${runId}: ${routing.decision} (${routing.reason}).`],
	);
}

function runResume(ctx, [runId]) {
	return runCommand(ctx, () => resumeCommand(ctx.root, { runId }), (result) => {
		if (!result.ok) return [`Run ${runId} not resumed: ${result.reason}`];
		const lines = [
			...result.tasks.map((task) => `  ${task.id}  ${task.state}`),
			`Run ${runId} resumed: ${result.state}.`,
		];
		if (!result.approval.valid) lines.push(`approval: not valid — ${result.approval.reasons.join("; ")}`);
		return lines;
	});
}

function runRecoverLock(ctx, [key]) {
	return runCommand(ctx, () => recoverLockCommand(ctx.root, { key }), (result) => [
		`Lock ${key} ${result.recovered ? "recovered" : "not recovered"}: ${result.reason}.`,
	]);
}

function runCancel(ctx, [runId]) {
	const reason = ctx.options.reason.trim();
	if (!reason) throw new UsageError("run cancel: --reason must not be empty");
	return runCommand(
		ctx,
		() => {
			requireOwnCheckout(ctx);
			return cancelCommand(ctx.root, { runId, reason });
		},
		(result) => {
			if (!result.ok) return [`Run ${runId} not cancelled: ${result.reason}.`];
			return [
				`Run ${runId} cancelled.`,
				`released locks: ${list(result.released)}`,
				`tasks now unknown: ${list(result.unknown_tasks)}`,
				...Object.entries(result.unaccepted_paths).map(
					([task, paths]) => `  ${task} left unaccepted: ${paths === null ? "unknown" : list(paths)}`,
				),
			];
		},
	);
}

// --- Gate --------------------------------------------------------------------------

// The push gate's checks, by hand, on the worktree of the current directory.
function gateCommand(ctx) {
	const result = manualGate({ cwd: ctx.root });
	if (ctx.json) {
		ctx.out.stdout(JSON.stringify(result));
	} else {
		for (const check of result.checks) ctx.out.stdout(`  pass  ${check}`);
		if (result.allow) ctx.out.stdout(`gate: ${plural(result.checks.length, "check")} passed.`);
		else ctx.out.stderr(result.message);
	}
	return result.allow ? 0 : 1;
}

// --- Status ------------------------------------------------------------------------

function status(ctx, [given]) {
	const runId = given ?? latestRunId(ctx.root);
	if (!runId) {
		ctx.out.stderr('aria status: no runs yet in this repository; start one with "aria run create <spec>"');
		return 1;
	}
	const verbosity = ctx.options.debug ? "debug" : ctx.options.verbose ? "standard" : "minimal";
	return runCommand(ctx, () => summaryCommand(ctx.root, { runId }), (summary) =>
		renderRunStatus(summary, {
			theme: createTheme(ctx.terminal),
			verbosity,
			terminal: ctx.terminal,
			runDir: `.aria/runs/${runId}`,
		}),
	);
}

// `args`: positional names, `?` marks an optional one. `options`: the
// command-specific flags it accepts.
const COMMANDS = {
	"validate config": { run: validateConfig, args: [] },
	"validate spec": { run: validateSpec, args: ["spec?"] },
	"validate graph": { run: validateGraph, args: ["spec"] },
	"validate handoff": { run: validateHandoff, args: ["spec", "file"], options: ["base"] },
	"validate run": { run: validateRun, args: ["run-id?"] },
	"validate workflows": { run: validateWorkflows, args: [] },
	"validate contracts": { run: validateContracts, args: [] },
	scope: { run: scope, args: [], options: ["base", "head"], requires: ["base", "head"] },
	classify: { run: classify, args: [], options: ["base", "head", "files", "manual"] },
	gate: { run: gateCommand, args: [] },
	status: { run: status, args: ["run-id?"], options: ["verbose", "debug"] },
	"run create": { run: runCreate, args: ["spec"] },
	"run plan": { run: runPlan, args: ["run-id"] },
	"run status": { run: runStatus, args: ["run-id"] },
	"run record-approval": { run: runRecordApproval, args: ["run-id"], options: ["event"] },
	"run start": { run: runStart, args: ["run-id", "task"] },
	"run verify": { run: runVerify, args: ["run-id", "task"] },
	"run accept": { run: runAccept, args: ["run-id", "task", "file"] },
	"run ready": { run: runReady, args: ["run-id"] },
	"run fail": {
		run: runFail,
		args: ["run-id", "task"],
		options: ["category", "repro", "requirement"],
		requires: ["category", "repro"],
	},
	"run resume": { run: runResume, args: ["run-id"] },
	"run recover-lock": { run: runRecoverLock, args: ["key"] },
	"run cancel": { run: runCancel, args: ["run-id"], options: ["reason"], requires: ["reason"] },
	"run select": { run: runSelect, args: ["run-id"], options: ["pr"] },
	"run observe": { run: runObserve, args: [], options: ["head", "checks"] },
};

const OPTIONS = {
	root: { type: "string" },
	json: { type: "boolean", default: false },
	help: { type: "boolean", short: "h", default: false },
	base: { type: "string" },
	head: { type: "string" },
	files: { type: "string" },
	manual: { type: "string" },
	event: { type: "string" },
	category: { type: "string" },
	repro: { type: "string" },
	requirement: { type: "string" },
	reason: { type: "string" },
	verbose: { type: "boolean", short: "v" },
	debug: { type: "boolean" },
	pr: { type: "string" },
	checks: { type: "string" },
};

// Identifiers that become paths or lock names are checked before any use.
const ARG_PATTERNS = {
	"run-id": [RUN_ID_PATTERN, "a run id such as 20260101T120000Z-0a1b2c"],
	task: [TASK_ID_PATTERN, "a task id such as T1"],
	key: [LOCK_KEY_PATTERN, "a lock key such as resource:port:3000"],
};
const OPTION_PATTERNS = {
	category: [new RegExp(`^(?:${DEFECT_CATEGORIES.join("|")})$`), `one of ${DEFECT_CATEGORIES.join(", ")}`],
	requirement: [/^R\d+(?:\.\d+)*$/, "a requirement id such as R1.2"],
	pr: [/^[1-9]\d{0,9}$/, "a pull request number"],
	checks: [/^[^\n]{1,2000}$/, "one line of at most 2000 characters"],
};

function findCommand(positionals) {
	for (const length of [2, 1]) {
		const name = positionals.slice(0, length).join(" ");
		if (Object.hasOwn(COMMANDS, name)) return { name, command: COMMANDS[name], rest: positionals.slice(length) };
	}
	return null;
}

function checkUsage(name, command, rest, values) {
	const required = command.args.filter((arg) => !arg.endsWith("?"));
	if (rest.length < required.length) {
		throw new UsageError(`${name}: missing <${required[rest.length]}>`);
	}
	if (rest.length > command.args.length) {
		throw new UsageError(`${name}: unexpected argument "${rest[command.args.length]}"`);
	}
	const allowed = new Set(["root", "json", "help", ...(command.options ?? [])]);
	for (const option of Object.keys(values)) {
		if (!allowed.has(option)) throw new UsageError(`${name} does not take --${option}`);
	}
	for (const option of command.requires ?? []) {
		if (!values[option]) throw new UsageError(`${name}: --${option} is required`);
	}
	// Run commands and `status` act on what they name. `validate run` only
	// inspects, and reports a malformed run id as a finding instead.
	const actsOnIds = name.startsWith("run ") || name === "status";
	command.args.forEach((arg, index) => {
		const [pattern, expected] = actsOnIds ? (ARG_PATTERNS[arg.replace(/\?$/, "")] ?? []) : [];
		if (pattern && rest[index] !== undefined && !pattern.test(rest[index])) {
			throw new UsageError(`${name}: "${rest[index]}" is not ${expected}`);
		}
	});
	for (const [option, [pattern, expected]] of Object.entries(OPTION_PATTERNS)) {
		if (values[option] !== undefined && !pattern.test(values[option])) {
			throw new UsageError(`${name}: --${option} must be ${expected} (found "${values[option]}")`);
		}
	}
	if (name === "classify" && !values.files && !(values.base && values.head)) {
		throw new UsageError("classify: give --base and --head, or --files");
	}
	if (name === "classify" && values.files && (values.base || values.head)) {
		throw new UsageError("classify: --files replaces --base/--head; give one or the other");
	}
}

function gitTopLevel(cwd) {
	try {
		return execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return cwd;
	}
}

// The plugin this binary belongs to: its question hook is the only one whose
// events approve a plan.
const PLUGIN_ROOT = join(import.meta.dirname, "..");

// `env` exists for in-process tests: the working directory, a plugin root
// with a question hook they know, and the terminal to render for. The
// binary never passes it.
export function main(
	argv,
	out = { stdout: console.log, stderr: console.error },
	{
		cwd = process.cwd(),
		pluginRoot = PLUGIN_ROOT,
		terminal = { env: process.env, isTTY: process.stdout.isTTY, platform: process.platform },
	} = {},
) {
	// Inherited GIT_DIR and the like never choose the repository.
	scrubGitLocationEnv();
	let values;
	let positionals;
	try {
		({ values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS }));
	} catch (error) {
		out.stderr(`${error.message}\n\n${USAGE}`);
		return 2;
	}
	if (values.help) {
		out.stdout(USAGE);
		return 0;
	}
	const found = findCommand(positionals);
	if (!found) {
		const given = positionals.length > 0 ? `unknown command "${positionals.join(" ")}"` : "no command given";
		out.stderr(`${given}\n\n${USAGE}`);
		return 2;
	}
	const root = values.root ? resolve(cwd, values.root) : gitTopLevel(cwd);
	let config;
	const ctx = {
		root,
		cwd,
		command: found.name,
		env: { pluginRoot },
		// `--json` never carries colour, whatever the terminal says.
		terminal: values.json ? { color: false, truecolor: false, unicode: true } : detectTerminal(terminal),
		json: values.json,
		options: values,
		out,
		config: () => {
			config ??= loadConfig(root);
			return config;
		},
	};
	try {
		checkUsage(found.name, found.command, found.rest, Object.fromEntries(
			Object.entries(values).filter(([key, value]) => value !== undefined && value !== false),
		));
		return found.command.run(ctx, found.rest);
	} catch (error) {
		if (error instanceof UsageError) {
			out.stderr(`${error.message}\n\nRun "aria --help" for usage.`);
			return 2;
		}
		if (error instanceof ConfigError || error instanceof ScopeError) {
			if (values.json) {
				const payload =
					error instanceof ConfigError
						? { ok: false, file: CONFIG_FILE, problems: error.problems }
						: { ok: false, problems: [error.message] };
				out.stdout(JSON.stringify(payload));
			} else {
				out.stderr(error.message);
			}
			return 1;
		}
		throw error;
	}
}

if (import.meta.main) {
	process.exitCode = main(process.argv.slice(2));
}
