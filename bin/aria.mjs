#!/usr/bin/env node
// The `aria` command line. Plan 0001 P3.1: validators, scope and impact
// classification. P3.2 adds the run commands to the same table.
//
// Exit codes: 0 ok, 1 findings or a refused check, 2 usage error (unknown
// command or spec, missing argument, unreadable input).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { scrubGitLocationEnv } from "../lib/approval-registry.mjs";
import { CONFIG_FILE, ConfigError, loadConfig } from "../lib/config.mjs";
import { buildExecutionGraph, listSpecDirs, resolveSpec } from "../lib/execution-graph.mjs";
import { ScopeError, changedScope, classifyImpact } from "../lib/impact.mjs";
import { compareHandoffToDelta, hardenedGit, snapshotTree, treeDelta } from "../lib/run-evidence.mjs";
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
  scope --base <ref> --head <ref>       Files and specs a change touches
  classify --base <ref> --head <ref>    Reviews a change requires
           [--files <list.json>]        ...from a JSON list of files instead
           [--manual <reviewers.json>]  ...plus {"required": [...]} from the spec

Options:
  --root <dir>      Repository root (default: the git top level of the
                    current directory)
  --json            Machine-readable output, no colour or decoration
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

// `args`: positional names, `?` marks an optional one. `options`: the
// command-specific flags it accepts.
const COMMANDS = {
	"validate config": { run: validateConfig, args: [] },
	"validate spec": { run: validateSpec, args: ["spec?"] },
	"validate graph": { run: validateGraph, args: ["spec"] },
	"validate handoff": { run: validateHandoff, args: ["spec", "file"], options: ["base"] },
	"validate run": { run: validateRun, args: ["run-id?"] },
	scope: { run: scope, args: [], options: ["base", "head"], requires: ["base", "head"] },
	classify: { run: classify, args: [], options: ["base", "head", "files", "manual"] },
};

const OPTIONS = {
	root: { type: "string" },
	json: { type: "boolean", default: false },
	help: { type: "boolean", short: "h", default: false },
	base: { type: "string" },
	head: { type: "string" },
	files: { type: "string" },
	manual: { type: "string" },
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

export function main(argv, out = { stdout: console.log, stderr: console.error }) {
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
	const root = values.root ? resolve(values.root) : gitTopLevel(process.cwd());
	let config;
	const ctx = {
		root,
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
