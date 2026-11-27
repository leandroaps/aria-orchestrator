// The push gate. Plan 0001 P4, ported from bernardo-pet
// `scripts/agent-push-gate.mjs`.
//
// Before a `git push` of a branch, the governance checks run on the pushed
// worktree: the config, every changed spec and its graph, and the reviews
// the change requires. A failure refuses the push with the check and the
// command that reproduces it. It is a convenience: CI stays the guarantee.
//
// The checks are aria's own code, run in this process; nothing from the
// pushed repository is executed. The directory must still be the root of a
// registered worktree of the project, with a clean tracked tree, so the
// tree checked is the tree pushed.

import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_FILE, ConfigError, loadConfig } from "./config.mjs";
import { buildExecutionGraph, resolveSpec } from "./execution-graph.mjs";
import { ScopeError, changedScope, classifyImpact } from "./impact.mjs";
import { hardenedGit } from "./run-evidence.mjs";
import { shellTokens } from "./shell-tokens.mjs";
import { graphFindings, specCategory, specFindings } from "./validate.mjs";

// A cheap check before reading anything: `git` then `push` in one segment,
// with global options in between, or a git alias defined in the command.
const PUSH_HINT = /\bgit\b[^\n;&|]*\bpush\b/;
const ALIAS_HINT = /\balias\./i;
const needsReading = (command) => PUSH_HINT.test(command) || (/\bgit\b/.test(command) && ALIAS_HINT.test(command));

// Prefixes that only pass the next command through.
const PASSTHROUGH = new Set(["command", "exec", "nohup", "time", "env"]);
// Prefixes that run another command, whose push the gate cannot read.
const WRAPPERS = new Set([
	"sh",
	"bash",
	"zsh",
	"dash",
	"eval",
	"xargs",
	"timeout",
	"nice",
	"sudo",
	"watch",
	"script",
	"su",
	"flock",
	"stdbuf",
]);
const WRAPPED_HINT =
	"a push wrapped in another command (sh -c, eval, xargs, timeout…) or a git alias does not go through the gate; run `git push` directly";
const RESOLVE_HINT = "push directory not resolvable from the command text; use `git -C <absolute path> push`";

const ALIAS_KEY = /^alias\./i;
const ALIAS_ENV = /^GIT_CONFIG_(KEY_\d+=alias\.|PARAMETERS=)/i;

const isGitToken = (token) => token === "git" || token.endsWith("/git");
const isAssignment = (token) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
const unresolvable = (token) => token.includes("$") || token.includes("`") || token.startsWith("~");

// A `git … push` the gate would not read as a push at the head of a segment,
// or a git alias in any spelling, by option or by environment.
function hiddenPush(tokens) {
	if (tokens.some((token) => ALIAS_ENV.test(token))) return true;
	let start = 0;
	while (start < tokens.length && (isAssignment(tokens[start]) || PASSTHROUGH.has(tokens[start]))) start += 1;
	const head = tokens[start];
	if (head && isGitToken(head)) {
		for (let at = start + 1; at < tokens.length; at += 1) {
			const token = tokens[at];
			const next = tokens[at + 1] ?? "";
			if (token === "-c" && ALIAS_KEY.test(next)) return true;
			if (/^--config-env=alias\./i.test(token)) return true;
			if (token === "--config-env" && ALIAS_KEY.test(next)) return true;
		}
		return false;
	}
	if (head && WRAPPERS.has(head.split("/").at(-1)) && tokens.some((token) => PUSH_HINT.test(token))) return true;
	const gitAt = tokens.findIndex((token, index) => index > start && isGitToken(token));
	return gitAt !== -1 && tokens.slice(gitAt + 1).includes("push");
}

// Reads one `git … push …` segment; `null` when it is not a push.
function parseGit(tokens) {
	let index = 0;
	const env = [];
	while (index < tokens.length) {
		const token = tokens[index];
		if (isAssignment(token)) env.push(token);
		else if (!PASSTHROUGH.has(token)) break;
		index += 1;
	}
	const head = tokens[index];
	if (!head || !isGitToken(head)) return null;
	const globals = { dirs: [], gitDirFlag: false };
	index += 1;
	while (index < tokens.length && tokens[index].startsWith("-")) {
		const option = tokens[index];
		if (option === "-C") {
			globals.dirs.push(tokens[index + 1] ?? "");
			index += 2;
		} else if (option === "-c") {
			index += 2;
		} else if (/^--(git-dir|work-tree|namespace)(=|$)/.test(option)) {
			globals.gitDirFlag = true;
			index += option.includes("=") ? 1 : 2;
		} else {
			index += 1;
		}
	}
	if (tokens[index] !== "push") return null;
	const args = tokens.slice(index + 1);
	const options = new Set();
	const positionals = [];
	for (let at = 0; at < args.length; at += 1) {
		const arg = args[at];
		if (arg === "-o" || arg === "--push-option" || arg === "--repo") at += 1;
		else if (arg.startsWith("-")) options.add(arg.split("=")[0]);
		else positionals.push(arg);
	}
	return {
		globals,
		gitEnv: env.some((token) => /^GIT_(DIR|WORK_TREE)=/.test(token)),
		options,
		remote: positionals[0],
		refspecs: positionals.slice(1),
	};
}

function pushIntent(push) {
	if (push.options.has("--delete") || push.options.has("-d")) return "delete";
	if (push.refspecs.length > 0 && push.refspecs.every((spec) => spec.startsWith(":"))) return "delete";
	if (push.options.has("--tags") && push.refspecs.length === 0) return "tags";
	return "branch";
}

// `{ pushes: [{ dir, push }] }` or `{ error }`. Runs no process.
export function readCommand(command, cwd) {
	if (!needsReading(command)) return { pushes: [] };
	// A lone `&` separates commands too; redirections (`2>&1`, `&>`) do not.
	const segments = command.replace(/\d*>&\d+|&>>?/g, " ").split(/\|\||&&|;|\||\n|&/);
	let current = cwd;
	let cdProblem = null;
	const pushes = [];
	for (const raw of segments) {
		const segment = raw.trim();
		if (!segment) continue;
		const grouped = /^[({]/.test(segment) || /[)}]$/.test(segment);
		// A push inside a command substitution is never read by the gate.
		const opener = segment.search(/\$\(|`|<\(|>\(/);
		if (opener !== -1 && /\bgit\b.*\bpush\b/.test(segment.slice(opener))) return { error: WRAPPED_HINT };
		// `\git` is git itself, without a shell alias.
		const tokens = shellTokens(segment.replace(/^[({]\s*|\s*[)}]$/g, "")).map((token) =>
			token.replace(/^\\+(?=(\S*\/)?git$)/, ""),
		);
		const [head, ...rest] = tokens;
		if (head === "cd") {
			const target = rest.filter((token) => !token.startsWith("-") || token === "-")[0];
			if (grouped || !target || target === "-" || unresolvable(target)) cdProblem = RESOLVE_HINT;
			else current = resolve(current, target);
			continue;
		}
		if (head === "pushd" || head === "popd") {
			cdProblem = RESOLVE_HINT;
			continue;
		}
		if (hiddenPush(tokens)) return { error: WRAPPED_HINT };
		const push = parseGit(tokens);
		if (!push || pushIntent(push) !== "branch") continue;
		if (cdProblem || grouped || push.gitEnv || push.globals.gitDirFlag) return { error: RESOLVE_HINT };
		if (push.globals.dirs.length > 1) return { error: `${RESOLVE_HINT} (more than one -C in one git)` };
		const [dashC] = push.globals.dirs;
		if (dashC !== undefined && (dashC === "" || unresolvable(dashC))) return { error: RESOLVE_HINT };
		if (push.options.has("--all") || push.options.has("--mirror")) {
			return { error: "a push with `--all` or `--mirror` does not go through the gate; push the current branch" };
		}
		if ([push.remote, ...push.refspecs].some((token) => token && unresolvable(token))) return { error: RESOLVE_HINT };
		pushes.push({ dir: dashC === undefined ? current : resolve(current, dashC), push });
	}
	return { pushes };
}

// Every refspec's source is HEAD or the current branch.
function refspecProblem(push, branch) {
	const allowed = new Set(["HEAD", "@", branch, `refs/heads/${branch}`]);
	for (const spec of push.refspecs) {
		const source = spec.replace(/^\+/, "").split(":")[0];
		if (!allowed.has(source)) {
			return `refspec "${spec}" sends content other than the checked HEAD; push the current branch (\`git push origin HEAD\`)`;
		}
	}
	return null;
}

// --- Worktree confinement and state ------------------------------------------

const git = (dir, args) => hardenedGit(dir, args).trim();

function registeredWorktrees(projectDir) {
	return git(projectDir, ["worktree", "list", "--porcelain"])
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length))
		.filter((path) => existsSync(path))
		.map((path) => realpathSync(path));
}

// The branch the change is compared with: the remote's default branch.
function defaultBase(dir) {
	try {
		return git(dir, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
	} catch {
		for (const name of ["main", "master"]) {
			try {
				git(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`]);
				return `refs/remotes/origin/${name}`;
			} catch {
				// Try the next name.
			}
		}
	}
	return null;
}

function prepare(dir, { projectDir, push, manual }) {
	if (!existsSync(dir) || !statSync(dir).isDirectory()) return { error: RESOLVE_HINT };
	const real = realpathSync(dir);
	if (!manual) {
		if (!projectDir) return { error: "CLAUDE_PROJECT_DIR is not set; run `aria gate` by hand" };
		let worktrees;
		try {
			worktrees = registeredWorktrees(projectDir);
		} catch (error) {
			return { error: `cannot list the worktrees: ${error.message.split("\n")[0]}` };
		}
		if (!worktrees.includes(real)) {
			return { error: `${real} is not the root of a registered worktree of the project; push from the worktree root` };
		}
		// `skip-worktree` (S) and `assume-unchanged` (lower case) hide changes
		// from the status.
		const hidden = git(real, ["ls-files", "-v"])
			.split("\n")
			.filter((line) => /^(S|[a-z]) /.test(line));
		if (hidden.length > 0) {
			return {
				error: `the tree cannot be checked: ${hidden.length} file(s) marked skip-worktree or assume-unchanged (${hidden[0].slice(2)}); clear the mark before pushing`,
			};
		}
		if (git(real, ["status", "--porcelain", "--untracked-files=no"])) {
			return { error: "the tracked tree has changes: commit or stash them before pushing" };
		}
	}
	if (push) {
		const problem = refspecProblem(push, git(real, ["rev-parse", "--abbrev-ref", "HEAD"]));
		if (problem) return { error: problem };
	}
	const base = defaultBase(real);
	if (!base) {
		return {
			error: "no origin default branch to compare with; run `git fetch origin && git remote set-head origin --auto`",
		};
	}
	return { dir: real, base };
}

// --- Checks -----------------------------------------------------------------

const deny = (message, checks = []) => ({ allow: false, checks, message });

function failure(name, findings, reproduce, checks) {
	return deny(`${name} failed\n${findings.map((line) => `  - ${line}`).join("\n")}\nreproduce: ${reproduce}`, checks);
}

export function runChecks({ dir, base }) {
	const checks = [];
	let config;
	try {
		config = loadConfig(dir);
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		return failure("validate config", error.problems, "aria validate config", checks);
	}
	checks.push("validate config");
	let scope;
	try {
		scope = changedScope(dir, { base, head: "HEAD" }, config);
	} catch (error) {
		if (error instanceof ScopeError) return deny(error.message, checks);
		throw error;
	}
	const specsDir = join(dir, config.specs.dir);
	for (const id of scope.specs) {
		const { name } = resolveSpec(specsDir, id);
		if (!name) continue; // the spec was removed
		const spec = specFindings(specsDir, name);
		if (spec.findings.length > 0) return failure(`validate spec ${name}`, spec.findings, `aria validate spec ${name}`, checks);
		checks.push(`validate spec ${name}`);
		if (specCategory(specsDir, name) === "Superseded" || !existsSync(join(specsDir, name, "tasks.md"))) continue;
		const graph = graphFindings(buildExecutionGraph(specsDir, name, config), config);
		if (graph.length > 0) return failure(`validate graph ${name}`, graph, `aria validate graph ${name}`, checks);
		checks.push(`validate graph ${name}`);
	}
	const impact = classifyImpact(scope.files, config, []);
	if (impact.undeclared.length > 0) {
		return failure(
			"classify",
			[`required reviewer(s) not declared in ${CONFIG_FILE}: ${impact.undeclared.join(", ")}`],
			`aria classify --base ${scope.base} --head HEAD`,
			checks,
		);
	}
	checks.push("classify");
	return { allow: true, checks };
}

// --- Decision ---------------------------------------------------------------

// The hook: `{ allow, checks, message? }`. A command that is not a branch
// push is allowed without reading the repository.
export function gate({ command, cwd, projectDir }) {
	if (typeof command !== "string" || !needsReading(command)) return { allow: true, checks: [] };
	const read = readCommand(command, cwd);
	if (read.error) return deny(read.error);
	const checks = [];
	for (const { dir, push } of read.pushes) {
		const prepared = prepare(dir, { projectDir, push, manual: false });
		if (prepared.error) return deny(prepared.error, checks);
		const result = runChecks(prepared);
		if (!result.allow) return result;
		checks.push(...result.checks);
	}
	return { allow: true, checks };
}

// `aria gate`: the same checks on the worktree of `cwd`, without the
// confinement and clean-tree rules a push needs.
export function manualGate({ cwd }) {
	let top;
	try {
		top = git(cwd, ["rev-parse", "--show-toplevel"]);
	} catch {
		return deny(`${cwd} is not inside a git worktree`);
	}
	const prepared = prepare(top, { manual: true });
	if (prepared.error) return deny(prepared.error);
	return runChecks(prepared);
}
