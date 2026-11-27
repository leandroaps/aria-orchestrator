// Real delta, sensitive set and evidence bound to a snapshot.
//
// Principles:
// - the delta comes from git with fixed flags (`core.fsmonitor`,
//   `core.hooksPath`, `core.excludesFile` neutralised) and ignores
//   `.git/info/exclude`, so local config cannot hide a changed file;
// - the handoff is a claim; the delta is an observation. `changed_files` must
//   be exactly the delta, and the delta must fit `allowed_paths`;
// - the ignored sensitive set (run state, local settings, git config and
//   hooks, env files, node_modules) is compared by digest; a secret enters
//   only as presence + digest, never as content;
// - verification runs in a disposable copy built from a synthetic index (the
//   exact tree verified), without a shell, only with commands from the plan;
//   the evidence records the tree and the digest of the command's resolved
//   chain.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, relative } from "node:path";
import { REGISTRY_DIR } from "./approval-registry.mjs";
import { STATE_DIR, loadConfig } from "./config.mjs";
import { pathFitsTerritory } from "./execution-graph.mjs";
import { sha256 } from "./run-state.mjs";

export const HARDENED_GIT_FLAGS = [
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.excludesFile=",
	"-c",
	"diff.external=",
	"-c",
	"core.attributesFile=",
	"--no-pager",
];

// Global and system config stay out (global clean/smudge filters would run
// on the snapshot's `git add`).
const HARDENED_GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

export function hardenedGit(root, args, { env = {}, input } = {}) {
	return execFileSync("git", [...HARDENED_GIT_FLAGS, ...args], {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...HARDENED_GIT_ENV, ...env },
		input,
		stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		maxBuffer: 64 * 1024 * 1024,
	});
}

// --- Snapshot as a git tree (synthetic index) --------------------------------

// Local files that never enter a snapshot (nor a verification archive), even
// when the repository's `.gitignore` does not cover them —
// `settings.local.json` is often ignored only by a user's global ignore. They
// are tracked by digest in `sensitiveSnapshot`.
const NEVER_SNAPSHOT = [
	/^\.claude\/settings\.local\.json$/,
	/(^|\/)\.env[^/]*$/,
	/(^|\/)\.dev\.vars$/,
	/\.pem$/,
];

function neverSnapshot(path) {
	return NEVER_SNAPSHOT.some((pattern) => pattern.test(path));
}

// Secret-bearing files at the repository root: presence + digest only.
function isRootSecret(name) {
	return name === ".dev.vars" || name.startsWith(".env") || name.endsWith(".pem");
}

// Tree representing the current working tree: tracked files + untracked
// files not ignored by the repository's own `.gitignore` files (no
// info/exclude, no global excludesFile). The real index is not touched.
export function snapshotTree(root) {
	const scratch = mkdtempSync(join(tmpdir(), "aria-index-"));
	const indexFile = join(scratch, "index");
	try {
		const env = { GIT_INDEX_FILE: indexFile };
		hardenedGit(root, ["read-tree", "HEAD"], { env });
		// Against the synthetic index (= HEAD), not the real one: a new file
		// already staged also counts as outside HEAD.
		const untracked = hardenedGit(
			root,
			["ls-files", "-z", "--others", "--exclude-per-directory=.gitignore"],
			{ env },
		)
			.split("\0")
			.filter((path) => path && !neverSnapshot(path));
		hardenedGit(root, ["add", "-u", "--", "."], { env });
		if (untracked.length > 0) {
			hardenedGit(root, ["add", "--pathspec-from-file=-", "--pathspec-file-nul", "-f"], {
				env,
				input: `${untracked.join("\0")}\0`,
			});
		}
		return hardenedGit(root, ["write-tree"], { env }).trim();
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

// Delta between two trees, with both sides of a rename.
export function treeDelta(root, fromTree, toTree) {
	const output = hardenedGit(root, [
		"diff",
		"--no-ext-diff",
		"--no-textconv",
		"-z",
		"--name-status",
		"-M",
		fromTree,
		toTree,
	]);
	const tokens = output.split("\0").filter(Boolean);
	const entries = [];
	for (let i = 0; i < tokens.length; ) {
		const status = tokens[i];
		if (status.startsWith("R") || status.startsWith("C")) {
			entries.push({ status: status[0], from: tokens[i + 1], path: tokens[i + 2] });
			i += 3;
		} else {
			entries.push({ status, path: tokens[i + 1] });
			i += 2;
		}
	}
	const paths = new Set();
	for (const entry of entries) {
		paths.add(entry.path);
		if (entry.from) paths.add(entry.from);
	}
	return { entries, paths: [...paths].sort() };
}

// --- Ignored sensitive set ---------------------------------------------------

function digestPath(absolute) {
	if (!existsSync(absolute)) return null;
	const stat = lstatSync(absolute);
	if (stat.isSymbolicLink()) return `symlink:${readlinkSync(absolute)}`;
	if (stat.isFile()) return sha256(readFileSync(absolute));
	if (stat.isDirectory()) {
		const parts = readdirSync(absolute)
			.sort()
			.map((name) => `${name}=${digestPath(join(absolute, name))}`);
		return sha256(parts.join("\n"));
	}
	return null;
}

function gitDirs(root) {
	const [gitDir, commonDir] = hardenedGit(root, [
		"rev-parse",
		"--git-dir",
		"--git-common-dir",
	])
		.trim()
		.split("\n")
		.map((dir) => (isAbsolute(dir) ? dir : join(root, dir)));
	return { gitDir, commonDir };
}

// The whole of `node_modules` by metadata (path, size, mtime and ctime of
// each entry). Reading contents would be expensive, but any write changes
// the ctime, which `touch` cannot restore.
function nodeModulesDigest(root) {
	const base = join(root, "node_modules");
	if (!existsSync(base)) return null;
	const hash = createHash("sha256");
	const walk = (dir) => {
		const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
		);
		for (const entry of entries) {
			const path = join(dir, entry.name);
			const stat = lstatSync(path, { bigint: true });
			hash.update(`${path}\0${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}\n`);
			if (entry.isDirectory()) walk(path);
		}
	};
	walk(realpathSync(base));
	return hash.digest("hex");
}

export function sensitiveSnapshot(root, { runId, dependsOn = [] } = {}) {
	const config = loadConfig(root);
	const { gitDir, commonDir } = gitDirs(root);
	const entries = {
		".claude/settings.local.json": digestPath(join(root, ".claude/settings.local.json")),
		node_modules: nodeModulesDigest(root),
	};
	// The approval registry and its consumptions live in the common dir; a
	// task never writes to them.
	for (const name of ["approval-events.jsonl", "consumed"]) {
		entries[`git-common-dir/${REGISTRY_DIR}/${name}`] = digestPath(
			join(commonDir, REGISTRY_DIR, name),
		);
	}
	// Generated, ignored files that enter the verification copy.
	for (const name of config.evidence.generatedInputs) {
		entries[name] = digestPath(join(root, name));
	}
	if (runId) {
		const runDir = join(root, STATE_DIR, "runs", runId);
		entries[`${STATE_DIR}/runs/${runId}/manifest.json`] = digestPath(
			join(runDir, "manifest.json"),
		);
		// State and evidence of dependencies already completed do not change
		// during this task; an indirect write to them shows up at `accept`.
		const evidenceDir = join(runDir, "evidence");
		const evidenceFiles = existsSync(evidenceDir) ? readdirSync(evidenceDir) : [];
		for (const dep of dependsOn) {
			entries[`${STATE_DIR}/runs/${runId}/tasks/${dep}.json`] = digestPath(
				join(runDir, "tasks", `${dep}.json`),
			);
			for (const name of evidenceFiles.filter((file) => file.startsWith(`${dep}-`))) {
				entries[`${STATE_DIR}/runs/${runId}/evidence/${name}`] = digestPath(
					join(evidenceDir, name),
				);
			}
		}
	}
	for (const [label, dir] of [
		["git-dir", gitDir],
		["git-common-dir", commonDir],
	]) {
		for (const name of ["config", "config.worktree", "hooks", "info"]) {
			entries[`${label}/${name}`] = digestPath(join(dir, name));
		}
	}
	for (const name of readdirSync(root)) {
		// Presence + digest; the content never leaves this process.
		if (isRootSecret(name)) entries[name] = digestPath(join(root, name));
	}
	return entries;
}

export function sensitiveChanges(before, after) {
	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	return [...keys].filter((key) => before[key] !== after[key]).sort();
}

// --- Handoff against the observed delta --------------------------------------

export function compareHandoffToDelta(handoff, delta, task) {
	const findings = [];
	const declared = new Set(handoff.changed_files ?? []);
	const observed = new Set(delta.paths);
	for (const path of observed) {
		if (!declared.has(path)) findings.push(`changed file missing from the handoff: ${path}`);
	}
	for (const path of declared) {
		if (!observed.has(path))
			findings.push(`handoff declares a file with no real change: ${path}`);
	}
	const territory = task.allowed_paths;
	for (const path of observed) {
		if (!pathFitsTerritory(path, territory)) {
			findings.push(`change outside the allowed_paths of ${task.id}: ${path}`);
		}
	}
	const taskRequirements = new Set(task.requirements);
	for (const [requirement, verdict] of Object.entries(handoff.requirements ?? {})) {
		if (!taskRequirements.has(requirement)) {
			findings.push(`handoff marks ${requirement}, which does not belong to ${task.id}`);
		}
		if (verdict === "ok" && !handoff.evidence?.[requirement]) {
			findings.push(`${requirement} = ok without an evidence reference`);
		}
	}
	return findings;
}

// --- Running a verification --------------------------------------------------

const SAFE_ARG = /^[A-Za-z0-9_./:@=+,-]+$/;
export const VERIFICATION_EXECUTABLES = ["npm", "node", "npx"];

// The command comes from the plan (task-meta `verification`), never from the
// handoff. Plain tokens only: no shell, no metacharacter, no redirection.
export function parseVerificationCommand(command) {
	const argv = command.trim().split(/\s+/);
	for (const token of argv) {
		if (!SAFE_ARG.test(token)) {
			throw new Error(`verification command with a disallowed token: "${token}"`);
		}
	}
	if (!VERIFICATION_EXECUTABLES.includes(argv[0])) {
		throw new Error(`verification executable not allowed: "${argv[0]}"`);
	}
	return argv;
}

// A script path that stays inside the snapshot.
function isContainedScript(path) {
	return !isAbsolute(path) && !path.split("/").includes("..");
}

// Digest of the chain the command resolves to in the snapshot: npm script
// bodies, the files they run with `node`, and `package.json`. Redefining a
// script changes the digest.
export function commandChainDigest(snapshotDir, argv) {
	const parts = [`argv=${argv.join(" ")}`];
	const packagePath = join(snapshotDir, "package.json");
	const packageJson = existsSync(packagePath)
		? JSON.parse(readFileSync(packagePath, "utf8"))
		: { scripts: {} };
	parts.push(`package.json=${digestPath(packagePath)}`);
	const visit = (scriptName, depth) => {
		const body = packageJson.scripts?.[scriptName];
		parts.push(`script:${scriptName}=${body ?? "(missing)"}`);
		if (!body || depth > 5) return;
		for (const nested of body.matchAll(/npm run(?: -s)? ([A-Za-z0-9:_-]+)/g)) {
			visit(nested[1], depth + 1);
		}
		for (const file of body.matchAll(/node ([A-Za-z0-9_./-]+\.[cm]?[jt]s)\b/g)) {
			if (!isContainedScript(file[1])) continue;
			parts.push(`file:${file[1]}=${digestPath(join(snapshotDir, file[1]))}`);
		}
	};
	if (argv[0] === "npm" && argv[1] === "run") visit(argv[2], 0);
	if (argv[0] === "node" && argv[1] && isContainedScript(argv[1])) {
		parts.push(`file:${argv[1]}=${digestPath(join(snapshotDir, argv[1]))}`);
	}
	return sha256(parts.join("\n"));
}

// The copy lives in `<worktree>/.aria/snapshots/`, with no symlink on the
// way and no fallback to the system tmp dir.
export function snapshotBase(root) {
	const state = join(root, STATE_DIR);
	const base = join(state, "snapshots");
	// Each level is checked before it is created, so nothing is created
	// through a symlink pointing outside the worktree.
	for (const path of [state, base]) {
		let stat = null;
		try {
			stat = lstatSync(path);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		if (stat?.isSymbolicLink()) throw new Error(`${path} is a symlink`);
		if (stat && !stat.isDirectory()) throw new Error(`${path} is not a directory`);
		if (!stat) mkdirSync(path);
	}
	if (realpathSync(base) !== join(realpathSync(root), STATE_DIR, "snapshots")) {
		throw new Error("snapshot base outside the worktree");
	}
	return base;
}

export function materializeSnapshot(root, tree) {
	const config = loadConfig(root);
	const dir = mkdtempSync(join(snapshotBase(root), "snapshot-"));
	try {
		const archive = execFileSync("git", [...HARDENED_GIT_FLAGS, "archive", tree], {
			cwd: root,
			env: { ...process.env, ...HARDENED_GIT_ENV },
			maxBuffer: 512 * 1024 * 1024,
		});
		execFileSync("tar", ["-x", "-C", dir], { input: archive });
		const generated = {};
		for (const name of config.evidence.generatedInputs) {
			const source = join(root, name);
			if (existsSync(source)) {
				mkdirSync(join(dir, name, ".."), { recursive: true });
				cpSync(source, join(dir, name));
				generated[name] = digestPath(source);
			}
		}
		// A real copy. Some build tools resolve a symlinked `node_modules` to
		// its target and leave the snapshot; a hardlink would change the
		// originals' ctime, which is part of the sensitive `node_modules`
		// digest. A `node_modules` that is itself a symlink is copied from its
		// real target: a `.gitignore` entry `node_modules/` does not ignore the
		// link, which then arrives through `git archive` and is removed first
		// (`rmSync` does not follow it).
		if (existsSync(join(root, "node_modules"))) {
			rmSync(join(dir, "node_modules"), { recursive: true, force: true });
			cpSync(realpathSync(join(root, "node_modules")), join(dir, "node_modules"), {
				recursive: true,
				verbatimSymlinks: true,
				preserveTimestamps: true,
			});
		}
		return { dir, generated };
	} catch (error) {
		// A failure halfway through leaves nothing behind.
		rmSync(dir, { recursive: true, force: true });
		throw error;
	}
}

// What the verification must not change in the real worktree: the tree, the
// sensitive set and all of `.aria/` except the snapshots themselves (runs,
// handoffs, loop target).
function worktreeState(root) {
	const state = join(root, STATE_DIR);
	const stateEntries = existsSync(state)
		? readdirSync(state)
				.filter((name) => name !== "snapshots")
				.sort()
				.map((name) => [name, digestPath(join(state, name))])
		: [];
	return {
		tree: snapshotTree(root),
		sensitive: sensitiveSnapshot(root),
		state: Object.fromEntries(stateEntries),
	};
}

// Says what changed, so `accept` can show the reason.
function worktreeStateChanges(before, after) {
	return [
		...(before.tree === after.tree ? [] : ["tree"]),
		...sensitiveChanges(before.sensitive, after.sensitive).map(
			(key) => `sensitive:${key}`,
		),
		...sensitiveChanges(before.state, after.state).map((key) => `${STATE_DIR}/${key}`),
	];
}

export function runVerification(root, { tree, command, timeoutMs = 30 * 60 * 1000 }) {
	const argv = parseVerificationCommand(command);
	const startedAt = new Date().toISOString();
	let snapshot;
	try {
		snapshot = materializeSnapshot(root, tree);
	} catch (error) {
		// No snapshot, no evidence — and no fallback.
		return {
			command,
			argv,
			tree,
			chain_digest: null,
			generated_inputs: {},
			exit_code: null,
			signal: null,
			error: "snapshot_unavailable",
			started_at: startedAt,
			finished_at: new Date().toISOString(),
			output_tail: error.message,
		};
	}
	const { dir, generated } = snapshot;
	try {
		const chainDigest = commandChainDigest(dir, argv);
		const before = worktreeState(root);
		const result = spawnSync(argv[0], argv.slice(1), {
			cwd: dir,
			encoding: "utf8",
			shell: false,
			timeout: timeoutMs,
			// git inside the snapshot does not climb up to the real repository.
			env: {
				...process.env,
				CI: process.env.CI ?? "",
				GIT_CEILING_DIRECTORIES: snapshotBase(root),
			},
			maxBuffer: 64 * 1024 * 1024,
		});
		const stateChanges = worktreeStateChanges(before, worktreeState(root));
		const tampered = stateChanges.length > 0;
		const exitCode =
			tampered || result.error || result.signal
				? null
				: typeof result.status === "number"
					? result.status
					: null;
		return {
			command,
			argv,
			tree,
			chain_digest: chainDigest,
			generated_inputs: generated,
			exit_code: exitCode,
			signal: result.signal ?? null,
			state_changes: stateChanges,
			error: tampered
				? `state changed by the verification: ${stateChanges.join(", ")}`
				: result.error
					? (result.error.code ?? "spawn_error")
					: null,
			started_at: startedAt,
			finished_at: new Date().toISOString(),
			// Minimal diagnostics: only the last lines, never the environment.
			output_tail: `${result.stdout ?? ""}${result.stderr ?? ""}`
				.split("\n")
				.slice(-15)
				.join("\n"),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// Only an observed exit 0 counts. Missing, null, signal or error = incomplete.
export function evidencePassed(evidence) {
	return (
		Boolean(evidence) && evidence.exit_code === 0 && !evidence.signal && !evidence.error
	);
}

// Evidence holds for the tree it ran on.
export function evidenceIsCurrent(evidence, currentTree) {
	return evidencePassed(evidence) && evidence.tree === currentTree;
}

export function safeRelative(root, path) {
	const normalized = normalize(path);
	if (isAbsolute(normalized) || normalized.startsWith("..")) {
		throw new Error(`path outside the root: ${path}`);
	}
	return relative(root, join(root, normalized));
}

export function ensureDir(path) {
	mkdirSync(path, { recursive: true });
	return path;
}

// For dependencies: a completion stays valid while the files the task
// changed are the same as in the tree where it was accepted.
export function pathsChangedSince(root, acceptedTree, currentTree, paths) {
	if (paths.length === 0 || acceptedTree === currentTree) return [];
	return hardenedGit(root, [
		"diff",
		"--no-ext-diff",
		"--no-textconv",
		"-z",
		"--name-only",
		acceptedTree,
		currentTree,
		"--",
		...paths,
	])
		.split("\0")
		.filter(Boolean);
}
