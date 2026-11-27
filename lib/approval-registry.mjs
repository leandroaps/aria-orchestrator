// Shared approval registry.
//
// Lives in `<git-common-dir>/aria/`, next to `locks/`, so an approval given
// in a session opened in any worktree counts for the run of another worktree
// of the same repository. It stores only ids, instants, source, digest
// prefix, run id and hook digest: never prompt, question or answer text.
//
// Nothing here trusts the environment or the disk:
// - the common dir is resolved with no inherited `GIT_*` variable and checked
//   against the worktree's `gitdir` pointer;
// - a directory or file that is a symlink, or owned by someone else, is
//   refused;
// - every line must carry the exact key set of its type;
// - consuming an event and the `PreToolUse` mark use exclusive creation.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;
export const EVENT_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const PREFIX_PATTERN = /^[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MARK_PART_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export const APPROVAL_SOURCE = "AskUserQuestion";
export const EVENT_SOURCES = ["UserPromptSubmit", APPROVAL_SOURCE];
// Closed list of rejection reasons.
export const REJECTION_REASONS = [
	"source_not_user",
	"non_interactive",
	"subagent",
	"prefilled_answers",
	"label_mismatch",
	"template_mismatch",
	"pre_check_missing",
	"unknown_payload_shape",
];

export const REGISTRY_DIR = "aria";
const REGISTRY_FILE = "approval-events.jsonl";

export function compactTimestamp(date = new Date()) {
	return date
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
}

export function newEventId(date = new Date()) {
	return `${compactTimestamp(date)}-${randomBytes(4).toString("hex")}`;
}

// --- Common dir resolution --------------------------------------------------

// `GIT_DIR`/`GIT_COMMON_DIR` and friends would point the registry at a
// directory chosen by the caller. No inherited `GIT_*` passes; global and
// system config stay out too.
function scrubbedGitEnv() {
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("GIT_")) env[key] = value;
	}
	return {
		...env,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_OPTIONAL_LOCKS: "0",
	};
}

// Variables that change which repository git sees. The controller deletes
// them from its own `process.env` at start-up; author identity and the like
// stay.
const GIT_LOCATION_ENV =
	/^GIT_(DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|NAMESPACE|CONFIG(_.*)?)$/;

export function scrubGitLocationEnv(env = process.env) {
	for (const key of Object.keys(env)) {
		if (GIT_LOCATION_ENV.test(key)) delete env[key];
	}
}

function realOrNull(path) {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

// Returns the real common dir of the repository at `root`, or `null` when it
// cannot be proven that `root` is a checkout of it (without git, nothing is
// written or accepted).
export function resolveCommonDir(root) {
	if (typeof root !== "string" || !isAbsolute(root)) return null;
	let output;
	try {
		output = execFileSync(
			"git",
			[
				"-c",
				"core.fsmonitor=false",
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"core.excludesFile=",
				"rev-parse",
				"--path-format=absolute",
				"--show-toplevel",
				"--git-dir",
				"--git-common-dir",
			],
			{
				cwd: root,
				encoding: "utf8",
				env: scrubbedGitEnv(),
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
	} catch {
		return null;
	}
	const [toplevel, gitDir, commonDir] = output.trim().split("\n");
	if (!toplevel || !gitDir || !commonDir) return null;
	const realTop = realOrNull(toplevel);
	const realGit = realOrNull(gitDir);
	const realCommon = realOrNull(commonDir);
	const dotGit = realTop && realOrNull(join(realTop, ".git"));
	if (!realTop || !realGit || !realCommon || !dotGit) return null;
	if (realGit === realCommon) {
		// Main checkout: `<root>/.git` is the common dir itself.
		return dotGit === realCommon ? realCommon : null;
	}
	// Linked worktree: its git dir lives in `<common>/worktrees/<name>` and its
	// `gitdir` file points back at the `<root>/.git` file.
	if (resolve(realGit, "..") !== join(realCommon, "worktrees")) return null;
	let pointer;
	try {
		pointer = readFileSync(join(realGit, "gitdir"), "utf8").trim();
	} catch {
		return null;
	}
	const pointed = realOrNull(isAbsolute(pointer) ? pointer : join(realGit, pointer));
	return pointed === dotGit ? realCommon : null;
}

// --- Registry directories and files -----------------------------------------

function ownedByMe(stat) {
	return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

// Ensures the directory is a real directory of the current user; creates it
// when missing.
function safeDir(path) {
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	}
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isDirectory() || !ownedByMe(stat)) {
		throw new Error(`${path}: registry directory is a symlink or owned by someone else`);
	}
	return path;
}

export function registryDir(commonDir) {
	safeDir(commonDir);
	return safeDir(join(commonDir, REGISTRY_DIR));
}

export function registryPath(commonDir) {
	return join(commonDir, REGISTRY_DIR, REGISTRY_FILE);
}

function openOwned(path, flags, mode) {
	const fd = openSync(path, flags | constants.O_NOFOLLOW, mode);
	const stat = fstatSync(fd);
	if (!stat.isFile() || !ownedByMe(stat)) {
		closeSync(fd);
		throw new Error(`${path}: registry file owned by someone else`);
	}
	return fd;
}

// --- Registry lines ---------------------------------------------------------

const KEYS = {
	approval: ["approves", "at", "hook_digest", "id", "run_id", "source"],
	rejection: ["at", "id", "rejected", "source"],
};

function sameKeys(line, expected) {
	const keys = Object.keys(line).sort();
	return keys.length === expected.length && keys.every((key, i) => key === expected[i]);
}

function validCommon(line) {
	return (
		typeof line.id === "string" &&
		EVENT_ID_PATTERN.test(line.id) &&
		typeof line.at === "string" &&
		Number.isFinite(Date.parse(line.at))
	);
}

export function isApprovalLine(line) {
	return (
		Boolean(line) &&
		typeof line === "object" &&
		sameKeys(line, KEYS.approval) &&
		validCommon(line) &&
		line.source === APPROVAL_SOURCE &&
		typeof line.approves === "string" &&
		PREFIX_PATTERN.test(line.approves) &&
		typeof line.run_id === "string" &&
		RUN_ID_PATTERN.test(line.run_id) &&
		typeof line.hook_digest === "string" &&
		DIGEST_PATTERN.test(line.hook_digest)
	);
}

export function isRejectionLine(line) {
	return (
		Boolean(line) &&
		typeof line === "object" &&
		sameKeys(line, KEYS.rejection) &&
		validCommon(line) &&
		EVENT_SOURCES.includes(line.source) &&
		REJECTION_REASONS.includes(line.rejected)
	);
}

function appendLine(commonDir, line) {
	registryDir(commonDir);
	const fd = openOwned(
		registryPath(commonDir),
		constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
		0o600,
	);
	try {
		writeSync(fd, `${JSON.stringify(line)}\n`);
	} finally {
		closeSync(fd);
	}
}

export function appendApproval(commonDir, { approves, runId, hookDigest }) {
	const line = {
		id: newEventId(),
		at: new Date().toISOString(),
		source: APPROVAL_SOURCE,
		approves,
		run_id: runId,
		hook_digest: hookDigest,
	};
	if (!isApprovalLine(line)) throw new Error("approval event out of shape");
	appendLine(commonDir, line);
	return line;
}

export function appendRejection(commonDir, { source, reason }) {
	const line = {
		id: newEventId(),
		at: new Date().toISOString(),
		source,
		rejected: reason,
	};
	if (!isRejectionLine(line)) throw new Error("rejection event out of shape");
	appendLine(commonDir, line);
	return line;
}

// Valid registry lines. A line with an unknown key, the keys of both types,
// or any other shape only counts as invalid. A missing registry is empty; a
// registry that is a symlink or owned by someone else throws.
export function readRegistry(commonDir) {
	const result = { approvals: [], rejections: [], invalidLines: 0 };
	let fd;
	try {
		const dirStat = lstatSync(join(commonDir, REGISTRY_DIR));
		if (dirStat.isSymbolicLink() || !dirStat.isDirectory() || !ownedByMe(dirStat)) {
			throw new Error("registry directory is a symlink or owned by someone else");
		}
		fd = openOwned(registryPath(commonDir), constants.O_RDONLY);
	} catch (error) {
		if (error.code === "ENOENT") return result;
		throw error;
	}
	let text;
	try {
		text = readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
	for (const raw of text.split("\n")) {
		if (!raw.trim()) continue;
		let line;
		try {
			line = JSON.parse(raw);
		} catch {
			result.invalidLines += 1;
			continue;
		}
		if (isApprovalLine(line)) result.approvals.push(line);
		else if (isRejectionLine(line)) result.rejections.push(line);
		else result.invalidLines += 1;
	}
	return result;
}

// --- PreToolUse mark ---------------------------------------------------------

function markPath(commonDir, sessionId, toolUseId) {
	if (!MARK_PART_PATTERN.test(sessionId) || !MARK_PART_PATTERN.test(toolUseId)) {
		throw new Error("session_id or tool_use_id out of shape");
	}
	const dir = safeDir(join(registryDir(commonDir), "pre-checked"));
	return join(dir, `${sessionId}-${toolUseId}`);
}

export function createPreCheckMark(commonDir, sessionId, toolUseId) {
	const fd = openSync(
		markPath(commonDir, sessionId, toolUseId),
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	closeSync(fd);
}

// Consumes the mark: `true` only if it existed as a file of the current user.
export function consumePreCheckMark(commonDir, sessionId, toolUseId) {
	let path;
	try {
		path = markPath(commonDir, sessionId, toolUseId);
		const stat = lstatSync(path);
		if (!stat.isFile() || !ownedByMe(stat)) return false;
		unlinkSync(path);
		return true;
	} catch {
		return false;
	}
}

// --- Event consumption -------------------------------------------------------

function consumedPath(commonDir, eventId, { create }) {
	if (!EVENT_ID_PATTERN.test(eventId)) throw new Error("event id out of shape");
	const dir = join(commonDir, REGISTRY_DIR, "consumed");
	if (create) safeDir(join(registryDir(commonDir), "consumed"));
	return join(dir, `${eventId}.json`);
}

// Exclusive creation: two concurrent `record-approval` calls cannot approve
// two runs with the same event. Repeating it for the same run is harmless.
export function claimEvent(commonDir, eventId, runId) {
	const path = consumedPath(commonDir, eventId, { create: true });
	try {
		const fd = openSync(
			path,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			writeSync(fd, `${JSON.stringify({ run_id: runId })}\n`);
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		const owner = eventConsumer(commonDir, eventId);
		if (owner !== runId) {
			throw new Error(
				`event ${eventId} already approved another run (${owner ?? "unreadable"})`,
			);
		}
	}
}

export function eventConsumer(commonDir, eventId) {
	try {
		const fd = openOwned(
			consumedPath(commonDir, eventId, { create: false }),
			constants.O_RDONLY,
		);
		let text;
		try {
			text = readFileSync(fd, "utf8");
		} finally {
			closeSync(fd);
		}
		const parsed = JSON.parse(text);
		return typeof parsed?.run_id === "string" && RUN_ID_PATTERN.test(parsed.run_id)
			? parsed.run_id
			: null;
	} catch {
		return null;
	}
}
