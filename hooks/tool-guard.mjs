#!/usr/bin/env node
// Tool guard for the `PreToolUse`, `Stop` and `SubagentStop` hooks. Plan 0001
// P4, ported from bernardo-pet `scripts/agent-tool-guard.mjs`.
//
// An operational control, not a sandbox: a local process of the same user
// can get around any rule here. The real guarantee stays in the controller
// (`aria run accept` compares the real change) and in review.
//
// Rules:
// - always, with or without a run, for any actor: nobody writes the approval
//   registry (`<git-common-dir>/aria/`), any `.git`, or a worktree pointer,
//   and nobody calls the approval hooks or the registry library through Bash;
// - always, for a subagent: no write to run state (`.aria/`, except
//   `.aria/handoffs/`), no lead-only run command, no opaque `node`;
// - without a running task: nothing else is required;
// - with a running task: writes only in the actor's territory (from the
//   payload's `agent_type`; the main session is the `lead`), never in the
//   sensitive set; `mcp__*` and `NotebookEdit` denied; read-only agents run
//   only allow-listed read commands, with allowed flags per command; the
//   `pr` agent only publishes and reads with `gh`.
//
// Usage: node hooks/tool-guard.mjs   (hook: the event's JSON on stdin)
// Registered with `|| exit 2`, so a crash, including a module that fails to
// load, blocks the tool.

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { REGISTRY_DIR, resolveCommonDir } from "../lib/approval-registry.mjs";
import { STATE_DIR, loadConfig } from "../lib/config.mjs";
import { buildExecutionGraph, pathFitsTerritory } from "../lib/execution-graph.mjs";
import { shellTokens } from "../lib/shell-tokens.mjs";

const WRITE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
// Agents of the workflow control steps (and the generic ones of the manual
// protocol): they write handoffs only.
const CONTROLLER_AGENTS = ["general-purpose", "Explore", "claude", "controller"];
const HANDOFFS = `${STATE_DIR}/handoffs/**`;

// --- Run state --------------------------------------------------------------

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

// Running tasks in any run of this worktree. Unreadable state counts as
// "unknown" and closes writes (fail closed inside a run).
export function activeTasks(root) {
	const base = join(root, STATE_DIR, "runs");
	if (!existsSync(base)) return { tasks: [], unreadable: false };
	const tasks = [];
	let unreadable = false;
	for (const runId of readdirSync(base)) {
		const manifest = readJson(join(base, runId, "manifest.json"));
		if (!manifest) {
			unreadable = true;
			continue;
		}
		if (manifest.state !== "running") continue;
		const tasksDir = join(base, runId, "tasks");
		if (!existsSync(tasksDir)) continue;
		for (const file of readdirSync(tasksDir)) {
			const state = readJson(join(tasksDir, file));
			if (!state) {
				unreadable = true;
				continue;
			}
			if (state.state === "running") tasks.push({ runId, spec: manifest.spec, ...state });
		}
	}
	return { tasks, unreadable };
}

// The caller's territory, from the running tasks and their task-meta, read
// through the same graph the controller uses.
function actorTerritory(root, config, actor, running) {
	const specsDir = join(root, config.specs.dir);
	const territory = [];
	for (const task of running) {
		let graph;
		try {
			graph = buildExecutionGraph(specsDir, task.spec, config);
		} catch {
			continue;
		}
		const node = graph.tasks.find((candidate) => candidate.id === task.task_id);
		if (node && node.owner === actor) territory.push(...node.allowed_paths);
	}
	if (actor === "lead") {
		for (const spec of new Set(running.map((task) => task.spec))) territory.push(`${config.specs.dir}/${spec}/**`);
		territory.push(HANDOFFS);
	}
	if (CONTROLLER_AGENTS.includes(actor)) territory.push(HANDOFFS);
	return territory;
}

// --- Paths ------------------------------------------------------------------

const RUN_STATE = new RegExp(`^${RegExp.escape(STATE_DIR)}/(?!handoffs(/|$))`);
const SENSITIVE_WRITE = [
	RUN_STATE,
	/^\.claude\/settings\.local\.json$/,
	/^\.git(\/|$)/,
	/(^|\/)\.env[^/]*$/,
	/(^|\/)\.dev\.vars[^/]*$/,
	/\.pem$/,
	/^node_modules(\/|$)/,
];

// Canonical path relative to the root; `null` when it escapes the root.
export function canonicalPath(root, cwd, rawPath) {
	if (typeof rawPath !== "string" || !rawPath) return null;
	const absolute = isAbsolute(rawPath) ? rawPath : resolve(cwd || root, rawPath);
	let realRoot;
	try {
		realRoot = realpathSync(root);
	} catch {
		realRoot = root;
	}
	let probe = absolute;
	const missing = [];
	while (!existsSync(probe) && dirname(probe) !== probe) {
		missing.unshift(probe.slice(dirname(probe).length + 1));
		probe = dirname(probe);
	}
	let realProbe;
	try {
		realProbe = realpathSync(probe);
	} catch {
		return null;
	}
	const rel = relative(realRoot, join(realProbe, ...missing));
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
	return rel.split(sep).join("/");
}

function danglingLink(path) {
	try {
		return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
	} catch {
		return null;
	}
}

// Real absolute path (nearest existing ancestor resolved). A dangling
// symlink is followed to its target: writing to it creates the target.
function realTarget(base, rawPath, depth = 0) {
	if (typeof rawPath !== "string" || !rawPath || depth > 40) return null;
	let probe = isAbsolute(rawPath) ? resolve(rawPath) : resolve(base, rawPath);
	const missing = [];
	while (!existsSync(probe) && dirname(probe) !== probe) {
		const link = danglingLink(probe);
		if (link !== null) return realTarget(dirname(probe), join(link, ...missing), depth + 1);
		missing.unshift(probe.slice(dirname(probe).length + 1));
		probe = dirname(probe);
	}
	try {
		return join(realpathSync(probe), ...missing);
	} catch {
		return null;
	}
}

function inside(child, parent) {
	return child === parent || child.startsWith(`${parent}${sep}`);
}

// The shared registry lives outside the worktree root, where `canonicalPath`
// gives `null`. Both the lexical and the real path are checked, so neither
// `..` nor a symlink reaches it.
export function protectedPathProblem(root, cwd, rawPath) {
	if (typeof rawPath !== "string" || !rawPath) return null;
	const base = cwd || root;
	const lexical = isAbsolute(rawPath) ? resolve(rawPath) : resolve(base, rawPath);
	const real = realTarget(base, rawPath);
	const candidates = [lexical, real].filter(Boolean);
	let realRoot;
	try {
		realRoot = realpathSync(root);
	} catch {
		realRoot = resolve(root);
	}
	const commonDir = resolveCommonDir(realRoot);
	if (commonDir) {
		const registry = join(commonDir, REGISTRY_DIR);
		if (candidates.some((path) => inside(path, registry))) {
			return "shared approval registry: only the approval hooks write it";
		}
		const worktrees = join(commonDir, "worktrees");
		const isPointer = (path) => {
			const parts = relative(worktrees, path).split(sep);
			return inside(path, worktrees) && parts.length === 2 && ["gitdir", "commondir"].includes(parts[1]);
		};
		if (candidates.some(isPointer)) return "git worktree pointers are not written by a tool";
	}
	// The `.git` of any worktree, not only this session's: rewriting another
	// worktree's `.git` would point its common dir at a forged registry.
	if (
		candidates.some(
			(path) => path.split(sep).includes(".git") || path.endsWith(`${sep}approval-events.jsonl`),
		)
	) {
		return "`.git` and the approval registry are not written by a tool";
	}
	// A hardlink to the registry would have another path: a file with more
	// than one link is not edited by a tool.
	if (real) {
		try {
			const stat = lstatSync(real);
			if (stat.isFile() && stat.nlink > 1) return "a hardlinked file is not written by a tool";
		} catch {
			// Target does not exist yet.
		}
	}
	return null;
}

function writeVerdict(path, territory) {
	if (path === null) return "path outside the repository root (or a symlink escape)";
	if (SENSITIVE_WRITE.some((pattern) => pattern.test(path))) return `${path} is in the run's sensitive set`;
	if (path === ".claude/settings.json" && !territory.includes(path)) {
		return ".claude/settings.json is outside the running task's territory";
	}
	if (!pathFitsTerritory(path, territory)) {
		return `${path} is outside the running task's territory (${territory.join(", ") || "none"})`;
	}
	return null;
}

// --- Bash -----------------------------------------------------------------

// A textual denial: a glob, a relative path or an import built at run time
// gets through. The controller still checks where an approval came from.
const APPROVAL_CHANNEL = /prompt-hook|question-hook|approval-registry|approval-events/;

// Code opaque to the guard, denied to a subagent in any state: `node` as a
// command (not as an argument, as in `rg node -e`), with any inline-code
// flag, loaders, or a program read from stdin (`node -`, `… | node`).
const NODE_INLINE_FLAG =
	/^(--(eval|print|input-type|import|require|loader|experimental-loader)(=.*)?|-[a-zA-Z]*[epri][a-zA-Z]*)$/;
const COMMAND_PREFIX = new Set(["env", "exec", "command", "time", "nice"]);

export function opaqueNodeInvocation(command) {
	const parts = command.split(/(\|\||&&|;|\||\n)/);
	for (let index = 0; index < parts.length; index += 2) {
		const piped = parts[index - 1] === "|";
		const tokens = shellTokens(parts[index].trim());
		let start = 0;
		while (
			start < tokens.length &&
			(/^\w+=/.test(tokens[start]) ||
				COMMAND_PREFIX.has(tokens[start]) ||
				(start > 0 && tokens[start].startsWith("-") && tokens[start - 1] === "env"))
		) {
			start += 1;
		}
		if (!/(^|\/)node(js)?$/.test(tokens[start] ?? "")) continue;
		const options = [];
		let script = null;
		for (const token of tokens.slice(start + 1)) {
			if (token === "-" || !token.startsWith("-")) {
				script = token;
				break;
			}
			options.push(token);
		}
		if (script === "-" || options.some((token) => NODE_INLINE_FLAG.test(token))) return true;
		if (script === null && (piped || /<(?!\()/.test(parts[index]))) return true;
	}
	return false;
}

// Commands no subagent runs during a task: content opaque to the guard, or
// git operations the Lead serialises.
const OPAQUE_OR_GIT_WRITE = [
	[/\b(bash|sh|zsh|dash)\s+-c\b/, "a nested shell"],
	[/\bpython3?\s+-c\b/, "python -c"],
	[/\beval\b/, "eval"],
	[
		/\bgit\s+(commit|push|checkout|switch|reset|stash|rebase|merge|worktree|config|clean|restore|rm|mv|add|update-index|update-ref|tag|branch\s+-[dDmM])\b/,
		"git that changes the index or a branch",
	],
];

// Write targets visible in the command (a documented heuristic: the
// comparison with the real change at `accept` decides).
export function bashWriteTargets(command) {
	const targets = [];
	for (const match of command.matchAll(/(?:^|[^<>&\d])(?:\d?>>?|&>)\s*([^\s;&|<>]+)/g)) targets.push(match[1]);
	for (const segment of command.split(/\|\||&&|;|\|/)) {
		const [head, ...rest] = shellTokens(segment.trim());
		const operands = rest.filter((token) => !token.startsWith("-"));
		if (head === "tee") targets.push(...operands);
		if (["rm", "touch", "mkdir", "truncate", "rmdir", "chmod", "chown"].includes(head)) {
			targets.push(...operands.slice(head === "chmod" || head === "chown" ? 1 : 0));
		}
		if (["cp", "ln", "install"].includes(head) && operands.length > 0) targets.push(operands.at(-1));
		if (head === "mv") targets.push(...operands);
		if (head === "sed" && rest.some((token) => /^-i/.test(token) || token === "--in-place")) {
			targets.push(...operands.slice(1));
		}
		if (head === "dd") for (const token of rest) if (token.startsWith("of=")) targets.push(token.slice(3));
	}
	return targets.filter((target) => !["/dev/null", "/dev/stderr", "/dev/stdout"].includes(target));
}

// Every operand of `ln`, not only the target: a hardlink made from the
// registry would give it another path.
export function linkOperands(command) {
	const operands = [];
	for (const segment of command.split(/\|\||&&|;|\|/)) {
		const [head, ...rest] = shellTokens(segment.trim());
		if (head === "ln") operands.push(...rest.filter((token) => !token.startsWith("-")));
	}
	return operands;
}

// Read-only auditors: an allow list by argv, with the flags allowed per
// subcommand — not a list of forbidden ones.
const GIT_READ = {
	status: /^(-s|--short|-b|--branch|--porcelain(=v[12])?|-z|-uno|--untracked-files=(no|normal|all))$/,
	diff: /^(--stat|--name-only|--name-status|--cached|--staged|--no-color|--color=never|-U\d+|--unified=\d+|-w|--ignore-all-space|-M|-z|--diff-filter=[ACDMRTUXB]+|--merge-base|--numstat|--shortstat|--word-diff|--exit-code|--quiet)$/,
	log: /^(--oneline|--stat|--name-only|--name-status|-n|-\d+|--max-count=\d+|--format=[^]*|--pretty=[^]*|--no-merges|--first-parent|--reverse|--graph|--decorate|--abbrev-commit|--since=[^]*|--until=[^]*|--author=[^]*|--grep=[^]*|--follow|-p|--patch|-z|--no-color)$/,
	show: /^(--stat|--name-only|--name-status|--format=[^]*|--pretty=[^]*|--oneline|--no-patch|-s|--no-color|-z)$/,
	"rev-parse":
		/^(--abbrev-ref|--short|--verify|--show-toplevel|--git-dir|--git-common-dir|--path-format=absolute|--is-inside-work-tree)$/,
	"ls-files": /^(-z|--others|--cached|--deleted|--modified|--exclude-standard|--full-name|-s|--stage)$/,
	blame: /^(-L|-w|-M|-C|-s|-e|--porcelain|-l)$/,
	"merge-base": /^(--is-ancestor|--all)$/,
	"cat-file": /^(-t|-s|-p|-e)$/,
};
const SEARCH_READ = {
	rg: /^(-n|-i|-l|-c|-w|-F|-e|-g|--glob=[^]*|-t\w*|--type=\w+|-A\d*|-B\d*|-C\d*|--hidden|--no-heading|--line-number|-S|--smart-case|--files|--files-with-matches|-m\d*|--max-count=\d+)$/,
	grep: /^(-[nilcrwFEHhsqvoR]+|-e|-A\d*|-B\d*|-C\d*|--include=[^]*|--exclude=[^]*|--exclude-dir=[^]*|-m\d*|--max-count=\d+|--color=never)$/,
};
const PLAIN_READ = new Set(["cat", "head", "tail", "wc", "ls", "pwd", "true", "echo", "sort", "uniq", "cut", "tr", "diff"]);
const ARIA_BIN = /(^|\/)bin\/aria\.mjs$/;

// `aria` commands that only read: the validators, scope, classify, status,
// and `run status`/`run ready`.
function ariaReadProblem(args) {
	const positionals = args.filter((arg) => !arg.startsWith("-"));
	const [command, sub] = positionals;
	if (["validate", "scope", "classify", "status"].includes(command)) return null;
	if (command === "run" && ["status", "ready"].includes(sub)) return null;
	return `aria ${[command, sub].filter(Boolean).join(" ")} is not a read command`;
}

function auditorSegmentProblem(tokens) {
	const [head, ...rest] = tokens;
	if (!head) return null;
	const command = head.replace(/^\/usr\/bin\//, "");
	if (command === "git") {
		const [subcommand, ...args] = rest[0] === "--no-pager" ? rest.slice(1) : rest;
		const allowed = GIT_READ[subcommand];
		if (!allowed) return `git ${subcommand ?? ""} is not in the read allow list`;
		const bad = args.filter((arg) => arg.startsWith("-") && arg !== "--" && !allowed.test(arg));
		return bad.length > 0 ? `flag not allowed for git ${subcommand}: ${bad.join(" ")}` : null;
	}
	if (SEARCH_READ[command]) {
		const bad = rest.filter((arg) => arg.startsWith("-") && arg !== "--" && !SEARCH_READ[command].test(arg));
		return bad.length > 0 ? `flag not allowed for ${command}: ${bad.join(" ")}` : null;
	}
	// sed has `w`, `W`, `e`, `r` and `R` inside its script: no cheap proof of a
	// pure read. Auditors read ranges with the Read tool.
	if (command === "sed") return "sed is not in the read allow list (use Read)";
	if (command === "uniq" && rest.filter((arg) => !arg.startsWith("-")).length > 1) return "uniq with an output file";
	if (command === "find") {
		return rest.some((arg) => /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)/.test(arg))
			? "find with an action that runs or writes"
			: null;
	}
	if (PLAIN_READ.has(command)) {
		return rest.some((arg) => /^-o|^--output/.test(arg)) ? `${command} with output to a file` : null;
	}
	if (command === "aria") return ariaReadProblem(rest);
	if (command === "node" && ARIA_BIN.test(rest[0] ?? "")) return ariaReadProblem(rest.slice(1));
	if (command === "node") return `node ${rest[0] ?? ""} is not in the read allow list`;
	return `${command} is not in the read allow list`;
}

export function auditorCommandProblem(command) {
	if (/\$\(|`|<\(|>\(/.test(command)) return "command or process substitution is not allowed";
	if (/(^|[^<>&\d])\d?>>?|&>/.test(command)) return "redirection to a file is not allowed";
	if (/;|&&|\|\||&\s*$/.test(command)) return "chaining commands is not allowed";
	for (const segment of command.split("|")) {
		const problem = auditorSegmentProblem(shellTokens(segment.trim()));
		if (problem) return problem;
	}
	return null;
}

// The `pr` agent publishes and reads with `gh`, one plain command, nothing
// chained; anything else is held to the auditors' read rules.
const GH_PUBLISH_OR_READ =
	/^gh (pr (create|ready|edit|comment|view|list|diff|checks)|issue view|api (-X GET )?repos\/[\w./-]+)(\s|$)/;

export function prCommandProblem(command) {
	if (GH_PUBLISH_OR_READ.test(command) && !/[;&|`>]|\$\(/.test(command)) return null;
	return auditorCommandProblem(command);
}

// Run commands reserved to the main session: recording an approval,
// resuming, freeing a lock, cancelling. A subagent that cancelled its own
// run would keep its change out of `accept`.
const LEAD_ONLY_RUN = /\b(aria|aria\.mjs)\b[^\n]*\brun\s+(record-approval|resume|recover-lock|cancel)\b/;

function subagentRunStateProblem(root, cwd, tool, input, path) {
	if (WRITE_TOOLS.includes(tool)) {
		return path !== null && RUN_STATE.test(path) ? `${path}: run state is not written by a subagent` : null;
	}
	if (tool !== "Bash") return null;
	const command = String(input.command ?? "");
	if (LEAD_ONLY_RUN.test(command)) {
		return "run record-approval, resume, recover-lock and cancel belong to the main session";
	}
	for (const target of bashWriteTargets(command)) {
		const resolved = canonicalPath(root, cwd, target);
		if (resolved !== null && RUN_STATE.test(resolved)) {
			return `indirect write to ${resolved}: run state is not written by a subagent`;
		}
	}
	return null;
}

// --- Decision ---------------------------------------------------------------

export function decide(payload, { root }) {
	const tool = payload.tool_name ?? "";
	const input = payload.tool_input ?? {};
	const cwd = payload.cwd || root;
	const isWrite = WRITE_TOOLS.includes(tool);
	const command = tool === "Bash" ? String(input.command ?? "") : "";
	const path = isWrite ? canonicalPath(root, cwd, input.file_path ?? input.notebook_path) : null;

	// In any state, for any actor.
	if (tool === "Bash" && APPROVAL_CHANNEL.test(command)) {
		return deny("the approval channel is not called through Bash");
	}
	const protectedTargets = isWrite
		? [input.file_path ?? input.notebook_path]
		: tool === "Bash"
			? [...bashWriteTargets(command), ...linkOperands(command)]
			: [];
	for (const target of protectedTargets) {
		const problem = protectedPathProblem(root, cwd, target);
		if (problem) return deny(problem);
	}

	// A subagent never touches run state or the lead-only commands, in any
	// state. Obfuscated writes through Bash stay beyond a textual heuristic.
	if (payload.agent_id) {
		if (tool === "Bash" && opaqueNodeInvocation(command)) {
			return deny("node with inline code (-e, --input-type, stdin) is not allowed to a subagent");
		}
		const problem = subagentRunStateProblem(root, cwd, tool, input, path);
		if (problem) return deny(problem);
	}

	const { tasks, unreadable } = activeTasks(root);
	if (tasks.length === 0 && !unreadable) return null;
	if (unreadable && (isWrite || tool === "Bash")) {
		return deny("run state unreadable: writes are blocked until `aria run resume` revalidates it");
	}

	const config = loadConfig(root);
	const actor = payload.agent_id ? String(payload.agent_type ?? "unknown") : "lead";
	const readOnly = config.agents[actor]?.mode === "read-only";

	if (tool.startsWith("mcp__") || tool === "NotebookEdit") return deny(`${tool} is denied while a task runs`);

	if (isWrite) {
		if (readOnly) return deny(`read-only agent "${actor}" does not write`);
		const problem = writeVerdict(path, actorTerritory(root, config, actor, tasks));
		return problem ? deny(problem) : null;
	}

	if (tool === "Bash") {
		if (actor === "pr") {
			const problem = prCommandProblem(command);
			return problem ? deny(`pr: ${problem}`) : null;
		}
		if (readOnly) {
			const problem = auditorCommandProblem(command);
			return problem ? deny(`read-only auditor: ${problem}`) : null;
		}
		if (actor !== "lead") {
			for (const [pattern, label] of OPAQUE_OR_GIT_WRITE) {
				if (pattern.test(command)) return deny(`${label} is not allowed to "${actor}" during the task`);
			}
		}
		const territory = actorTerritory(root, config, actor, tasks);
		for (const target of bashWriteTargets(command)) {
			const problem = writeVerdict(canonicalPath(root, cwd, target), territory);
			if (problem) return deny(`indirect write: ${problem}`);
		}
	}
	return null;
}

// `Stop` never loops: after a continuation, or with no running task, it
// hands control back; otherwise it asks for one continuation so the running
// task is accepted or recorded as failed. Only the main session closes tasks.
export function decideStop(payload, { root }) {
	if (payload.stop_hook_active || payload.agent_id) return null;
	const { tasks } = activeTasks(root);
	if (tasks.length === 0) return null;
	return {
		decision: "block",
		reason: `task(s) still running: ${tasks.map((task) => `${task.task_id} (run ${task.runId})`).join(", ")}; run "aria run accept" or "aria run fail" before stopping.`,
	};
}

function deny(reason) {
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: `[aria tool-guard] ${reason}`,
		},
	};
}

// --- Entry ----------------------------------------------------------------

function runHook() {
	let payload;
	try {
		payload = JSON.parse(readFileSync(0, "utf8"));
	} catch {
		return; // nothing to decide without a readable payload
	}
	const root = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();
	if (payload.hook_event_name === "Stop" || payload.hook_event_name === "SubagentStop") {
		const result = decideStop(payload, { root });
		if (result) process.stdout.write(JSON.stringify(result));
		return;
	}
	if (payload.hook_event_name !== "PreToolUse") return;
	let result;
	try {
		result = decide(payload, { root });
	} catch (error) {
		// Inside a run, a guard error closes everything; outside one, only the
		// write tools.
		let running = true;
		try {
			running = activeTasks(root).tasks.length > 0;
		} catch {
			// Unreadable state counts as a run in progress.
		}
		result =
			running || WRITE_TOOLS.includes(payload.tool_name) ? deny(`internal error: ${error.message}`) : null;
	}
	if (result) process.stdout.write(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	runHook();
	process.exit(0);
}
