// The run controller: what `aria run <command>` does. Plan 0001 P3.2, ported
// from bernardo-pet `scripts/agent-run.mjs`.
//
// Every function takes the repository root and returns a plain result object
// with `ok`. A refusal by the run contract throws an Error; the command line
// turns it into exit 1. Workers never call `recordApprovalCommand`: only the
// owner's click, written by the plugin's question hook, approves a plan.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RUN_ID_PATTERN, registryDir, resolveCommonDir } from "./approval-registry.mjs";
import { approvalQuestion } from "./approval-template.mjs";
import { STATE_DIR, loadConfig } from "./config.mjs";
import { pathFitsTerritory } from "./execution-graph.mjs";
import {
	compareHandoffToDelta,
	ensureDir,
	evidencePassed,
	hardenedGit,
	pathsChangedSince,
	runVerification,
	sensitiveChanges,
	sensitiveSnapshot,
	snapshotTree,
	treeDelta,
} from "./run-evidence.mjs";
import {
	APPROVAL_PREFIX_LENGTH,
	CONTROL_FILES,
	DEFECT_CATEGORIES,
	acquireLock,
	appendRunEvent,
	approvalEventsPath,
	approvalStatus,
	concurrencyConflicts,
	createRun,
	externalResources,
	humanApprovalEvents,
	lastPresentedAt,
	lastRejectionSince,
	planContract,
	planDigest,
	presentPlan,
	readDefects,
	readJsonl,
	readManifest,
	readiness,
	recordApproval,
	recordDefect,
	recoverLock,
	releaseLock,
	resourceKeys,
	runPath,
	runsDir,
	saveManifest,
	sha256,
	taskIsBlockedByDefects,
	transition,
	writeJsonAtomic,
} from "./run-state.mjs";

export const TASK_ID_PATTERN = /^(?:T\d+|TN)$/;

// The question hook ships inside the plugin (plan 0001 P4). Only events it
// wrote approve; its digest is read from the installed plugin, never from
// the repository a worker can edit.
export const QUESTION_HOOK = join("hooks", "question-hook.mjs");

function git(root, args) {
	return hardenedGit(root, args).trim();
}

function tasksBlob(root, spec) {
	return git(root, ["hash-object", join(loadConfig(root).specs.dir, spec, "tasks.md")]);
}

function taskStatePath(root, runId, taskId) {
	if (!TASK_ID_PATTERN.test(taskId)) throw new Error(`invalid task id: "${taskId}"`);
	return join(ensureDir(join(runPath(root, runId), "tasks")), `${taskId}.json`);
}

function readTaskState(root, runId, taskId) {
	const path = taskStatePath(root, runId, taskId);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error(`state of ${taskId} is corrupted; resuming must revalidate the task`);
	}
}

function planTask(root, manifest, taskId) {
	const task = planContract(root, manifest.spec).nodes.find((node) => node.id === taskId);
	if (!task) throw new Error(`${taskId} is not in the plan of ${manifest.spec}`);
	return task;
}

function allTaskStates(root, runId, contract) {
	const states = {};
	for (const node of contract.nodes) {
		try {
			const state = readTaskState(root, runId, node.id);
			if (state) states[node.id] = state;
		} catch {
			states[node.id] = { task_id: node.id, state: "unknown", reason: "corrupted state" };
		}
	}
	return states;
}

function locksDir(root) {
	const commonDir = resolveCommonDir(root);
	if (!commonDir) throw new Error("git common dir not proven; locks unavailable");
	return join(registryDir(commonDir), "locks");
}

function worktreeLockKey(root) {
	return `worktree:${sha256(root).slice(0, 16)}`;
}

function releaseTaskLocks(root, runId, task) {
	for (const key of resourceKeys(task)) releaseLock(locksDir(root), key, runId);
}

// A cancelled run never moves again, whatever the command.
function refuseCancelled(manifest) {
	if (manifest.state === "cancelled") throw new Error(`run ${manifest.run_id} is cancelled`);
}

function blockRun(root, manifest) {
	if (["blocked", "cancelled", "failed"].includes(manifest.state)) return manifest;
	const next = transition(manifest, "blocked");
	saveManifest(root, next);
	return next;
}

// The approval must hold for the current plan. An edit of a control file is
// tolerated only when the task's own territory includes it.
function requireValidApproval(root, manifest, task) {
	const plannedControlEdits = Object.values(CONTROL_FILES).filter((path) =>
		task.allowed_paths.includes(path),
	);
	const status = approvalStatus(root, manifest, { plannedControlEdits });
	if (!status.valid) throw new Error(`approval not valid for dispatch: ${status.reasons.join("; ")}`);
}

function readEvidence(root, runId, checkId) {
	if (!/^(?:T\d+|TN)-a\d+-c\d+$/.test(checkId)) return null;
	const path = join(runPath(root, runId), "evidence", `${checkId}.json`);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

// A completion holds while every recorded evidence exists, passed on the
// acceptance tree, and the files of its delta have not changed since.
function completionIsValid(root, runId, node, state, currentTree) {
	if (state?.state !== "completed" || !state.end_tree) return false;
	const evidence = (state.evidence ?? []).map((checkId) => readEvidence(root, runId, checkId));
	if (evidence.length === 0 && node.verification.length > 0) return false;
	if (!evidence.every((item) => evidencePassed(item) && item.tree === state.end_tree)) return false;
	return pathsChangedSince(root, state.end_tree, currentTree, state.delta ?? []).length === 0;
}

// Runs every verification of the plan, in this process, on the current
// tree. Evidence written earlier is a cache, not proof.
function verifyTask(root, runId, task, attempt) {
	const tree = snapshotTree(root);
	const evidenceDir = ensureDir(join(runPath(root, runId), "evidence"));
	const results = task.verification.map((command, index) => {
		const evidence = {
			run_id: runId,
			task_id: task.id,
			attempt,
			requirements: task.requirements,
			...runVerification(root, { tree, command }),
		};
		const checkId = `${task.id}-a${attempt}-c${index + 1}`;
		// The output can carry data from the developer's branch: it goes back
		// to the caller only, and the run directory keeps a digest.
		const { output_tail: outputTail, ...persisted } = evidence;
		writeJsonAtomic(join(evidenceDir, `${checkId}.json`), {
			check_id: checkId,
			...persisted,
			output_digest: sha256(outputTail ?? ""),
		});
		return {
			check_id: checkId,
			command,
			exit_code: evidence.exit_code,
			error: evidence.error,
			passed: evidencePassed(evidence),
			output_tail: outputTail,
		};
	});
	return { tree, results, passed: results.length > 0 && results.every((result) => result.passed) };
}

// With concurrent writers, the delta since `start` also holds the other
// tasks' work. A path outside this task's territory leaves the delta when a
// concurrent task claims it: one still running (by its territory, disjoint
// from this one's) that changed it since its own start, or one accepted
// after our start whose recorded delta still matches its end tree. A path
// inside this task's territory always stays its own.
function withoutConcurrentWork(root, runId, manifest, task, state, delta, currentTree) {
	const own = task.allowed_paths;
	const startedAt = Date.parse(state.started_at);
	const candidates = new Set();
	for (const entry of delta.entries) {
		for (const path of [entry.path, entry.from]) {
			if (path !== undefined && !pathFitsTerritory(path, own)) candidates.add(path);
		}
	}
	const claimed = new Set();
	if (candidates.size > 0) {
		for (const node of planContract(root, manifest.spec).nodes) {
			if (node.id === task.id) continue;
			const other = readTaskState(root, runId, node.id);
			if (!other) continue;
			if (other.state === "running" && other.start_tree) {
				const inTerritory = [...candidates].filter((path) => pathFitsTerritory(path, node.allowed_paths));
				for (const path of pathsChangedSince(root, other.start_tree, currentTree, inTerritory)) {
					if (inTerritory.includes(path)) claimed.add(path);
				}
			} else if (
				other.state === "completed" &&
				other.end_tree &&
				Date.parse(other.finished_at) >= startedAt &&
				Array.isArray(other.delta)
			) {
				const recorded = [...candidates].filter((path) => other.delta.includes(path));
				const changed = new Set(pathsChangedSince(root, other.end_tree, currentTree, recorded));
				for (const path of recorded) if (!changed.has(path)) claimed.add(path);
			}
		}
	}
	const keep = (path) => pathFitsTerritory(path, own) || !claimed.has(path);
	const entries = delta.entries.filter(
		(entry) => keep(entry.path) || (entry.from !== undefined && keep(entry.from)),
	);
	const paths = new Set();
	for (const entry of entries) {
		if (keep(entry.path)) paths.add(entry.path);
		if (entry.from !== undefined && keep(entry.from)) paths.add(entry.from);
	}
	return { entries, paths: [...paths].sort() };
}

const FINDING_CATEGORIES = [
	[/^verification failed|has no verification/, "verification_failed"],
	[/outside the allowed_paths/, "out_of_territory"],
	[/sensitive set/, "sensitive_change"],
	[/without an evidence reference|tree changed/, "missing_evidence"],
	[/missing from the handoff|no real change|does not belong/, "delta_mismatch"],
];

function categorize(finding) {
	return FINDING_CATEGORIES.find(([pattern]) => pattern.test(finding))?.[1] ?? "other";
}

// --- Commands ------------------------------------------------------------------

export function createCommand(root, { spec }) {
	const manifest = createRun(root, {
		spec,
		worktree: root,
		branch: git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
		baseCommit: git(root, ["rev-parse", "HEAD"]),
	});
	return { ok: true, run: manifest };
}

export function planCommand(root, { runId }) {
	refuseCancelled(readManifest(root, runId));
	const { manifest, digest, prefix } = presentPlan(root, runId);
	return {
		ok: true,
		run_id: runId,
		spec: manifest.spec,
		state: manifest.state,
		plan_digest: digest,
		approval_prefix: prefix,
		// Only the owner's click on this exact question approves; the question
		// hook records it.
		approval_question: approvalQuestion({ runId, spec: manifest.spec, prefix }, loadConfig(root).locale),
		instruction: `Ask the owner with AskUserQuestion, passing approval_question exactly as given and nothing else (no answers). Only their click approves; then run "aria run record-approval ${runId}".`,
		tasks: planContract(root, manifest.spec).nodes.map(({ id, owner, depends_on, allowed_paths }) => ({
			id,
			owner,
			depends_on,
			allowed_paths,
		})),
	};
}

export function statusCommand(root, { runId }) {
	const manifest = readManifest(root, runId);
	const digest = planDigest(planContract(root, manifest.spec));
	const { invalidLines } = readJsonl(join(runPath(root, runId), "events.jsonl"));
	return {
		ok: true,
		run_id: runId,
		spec: manifest.spec,
		state: manifest.state,
		plan_digest_current: digest,
		plan_digest_recorded: manifest.plan_digest,
		approval: manifest.approval
			? { ...approvalStatus(root, manifest), event_id: manifest.approval.event_id }
			: null,
		invalid_event_lines: invalidLines,
	};
}

export function recordApprovalCommand(root, { runId, eventId }, { pluginRoot }) {
	const hookPath = join(pluginRoot, QUESTION_HOOK);
	if (!existsSync(hookPath)) {
		throw new Error(
			`the plugin has no question hook (${QUESTION_HOOK}); an approval cannot be recorded without it`,
		);
	}
	const hookDigest = sha256(readFileSync(hookPath));
	const manifest = readManifest(root, runId);
	refuseCancelled(manifest);
	let event = eventId;
	if (!event) {
		const prefix = planDigest(planContract(root, manifest.spec)).slice(0, APPROVAL_PREFIX_LENGTH);
		event = humanApprovalEvents(root)
			.filter((candidate) => candidate.run_id === runId && candidate.approves === prefix)
			.at(-1)?.id;
		if (!event) {
			// Say where it looked and the last rejection it saw.
			const where = approvalEventsPath(root) ?? "(git common dir not proven)";
			const rejected = lastRejectionSince(root, lastPresentedAt(root, runId));
			throw new Error(
				`no approval event for ${prefix} in ${where}; last rejection: ${
					rejected ? `${rejected.rejected} (${rejected.source})` : "none"
				}; the run is still awaiting_approval`,
			);
		}
	}
	const updated = recordApproval(root, runId, {
		eventId: event,
		tasksBlob: tasksBlob(root, manifest.spec),
		headCommit: git(root, ["rev-parse", "HEAD"]),
		acceptedHookDigests: [hookDigest],
	});
	return { ok: true, run_id: runId, state: updated.state, approval: updated.approval };
}

export function startCommand(root, { runId, taskId }) {
	let manifest = readManifest(root, runId);
	if (["blocked", "cancelled", "failed", "ready_for_review"].includes(manifest.state)) {
		throw new Error(`run in "${manifest.state}": no automatic dispatch`);
	}
	const task = planTask(root, manifest, taskId);
	requireValidApproval(root, manifest, task);
	const contract = planContract(root, manifest.spec);
	const states = allTaskStates(root, runId, contract);
	const currentTree = snapshotTree(root);
	const ready = readiness(contract, states, (node, state) =>
		completionIsValid(root, runId, node, state, currentTree),
	).find((entry) => entry.id === taskId);
	if (ready.blockers.length > 0) throw new Error(`${taskId} is not ready: ${ready.blockers.join("; ")}`);
	const blockingDefects = taskIsBlockedByDefects(root, runId, taskId);
	if (blockingDefects.length > 0) {
		throw new Error(
			`${taskId} blocked by the attempt limit or by no progress (${blockingDefects
				.map(([key]) => key)
				.join(", ")}): human decision needed`,
		);
	}
	const conflicts = concurrencyConflicts(contract, states, taskId);
	if (conflicts.length > 0) throw new Error(`concurrency: ${conflicts.join("; ")}`);
	const external = externalResources(task, loadConfig(root));
	if (external.length > 0) {
		throw new Error(
			`shared resource outside this repository (${external.join(", ")}): a local lock cannot prove exclusivity; human decision`,
		);
	}
	const previous = states[taskId];
	if (previous?.state === "completed") throw new Error(`${taskId} is already completed in this run`);
	const owner = { run_id: runId, task_id: taskId, worktree: root };
	const dir = locksDir(root);
	const taken = [];
	let state;
	try {
		const worktreeLock = acquireLock(dir, worktreeLockKey(root), owner);
		if (!worktreeLock.acquired) {
			throw new Error(`worktree in use by run ${worktreeLock.holder?.run_id ?? "?"}`);
		}
		if (!worktreeLock.reentrant) taken.push(worktreeLockKey(root));
		// A `cancel` between the manifest read above and the lock leaves no
		// new task in a cancelled run.
		if (readManifest(root, runId).state === "cancelled") throw new Error(`run ${runId} was cancelled`);
		for (const key of resourceKeys(task)) {
			const lock = acquireLock(dir, key, owner);
			if (!lock.acquired) throw new Error(`resource ${key} in use by run ${lock.holder?.run_id ?? "?"}`);
			if (!lock.reentrant) taken.push(key);
		}
		// Attempt numbers never go back: an `unknown` state (interrupted or
		// unreadable) still counts the attempts in the events, or the new one
		// would reuse an id and overwrite the earlier evidence.
		const startedBefore = readJsonl(join(runPath(root, runId), "events.jsonl")).entries.filter(
			(event) => event.type === "task_started" && event.task === taskId,
		).length;
		const lastAttempt = Math.max(Number.isInteger(previous?.attempt) ? previous.attempt : 0, startedBefore);
		if (manifest.state === "approved") {
			manifest = transition(manifest, "running");
			saveManifest(root, manifest);
		}
		state = {
			task_id: taskId,
			owner: task.owner,
			attempt: lastAttempt + 1,
			state: "running",
			start_tree: currentTree,
			sensitive_before: sensitiveSnapshot(root, { runId, dependsOn: task.depends_on }),
			started_at: new Date().toISOString(),
		};
	} catch (error) {
		for (const key of taken.reverse()) releaseLock(dir, key, runId);
		throw error;
	}
	writeJsonAtomic(taskStatePath(root, runId, taskId), state);
	appendRunEvent(root, runId, { type: "task_started", task: taskId, attempt: state.attempt });
	return { ok: true, run_id: runId, task: taskId, attempt: state.attempt, start_tree: state.start_tree };
}

export function verifyCommand(root, { runId, taskId }) {
	const manifest = readManifest(root, runId);
	refuseCancelled(manifest);
	const task = planTask(root, manifest, taskId);
	const state = readTaskState(root, runId, taskId);
	if (!state) throw new Error(`${taskId} was not started in this run (use start)`);
	const result = verifyTask(root, runId, task, state.attempt);
	return { ok: result.passed, run_id: runId, task: taskId, ...result };
}

// `handoff` is the parsed JSON the worker returned.
export function acceptCommand(root, { runId, taskId, handoff }) {
	const manifest = readManifest(root, runId);
	refuseCancelled(manifest);
	const task = planTask(root, manifest, taskId);
	const state = readTaskState(root, runId, taskId);
	if (!state || state.state !== "running") throw new Error(`${taskId} is not running in this run`);
	const findings = [];
	if (handoff.task !== taskId) findings.push(`the handoff is for "${handoff.task}", not ${taskId}`);
	if (handoff.agent !== task.owner) {
		findings.push(`handoff.agent "${handoff.agent}" differs from the owner "${task.owner}"`);
	}
	const sensitive = sensitiveChanges(
		state.sensitive_before,
		sensitiveSnapshot(root, { runId, dependsOn: task.depends_on }),
	);
	for (const key of sensitive) findings.push(`sensitive set changed during the task: ${key}`);

	const currentTree = snapshotTree(root);
	const delta = withoutConcurrentWork(
		root,
		runId,
		manifest,
		task,
		state,
		treeDelta(root, state.start_tree, currentTree),
		currentTree,
	);
	findings.push(...compareHandoffToDelta(handoff, delta, task));

	let verification = null;
	if (findings.length === 0) {
		verification = verifyTask(root, runId, task, state.attempt);
		if (verification.tree !== currentTree) {
			findings.push("the tree changed during the verification; evidence discarded");
		}
		for (const result of verification.results) {
			if (!result.passed) {
				// The reason goes inside the `exit` parentheses, which the defect's
				// reproduction drops; routing does not change with it.
				findings.push(
					`verification failed: ${result.command} (exit ${result.exit_code}${result.error ? `; ${result.error}` : ""})`,
				);
			}
		}
		if (verification.results.length === 0) findings.push(`${taskId} has no verification in the plan`);
	}

	const accepted = findings.length === 0;
	releaseTaskLocks(root, runId, task);
	let routing = null;
	if (accepted) {
		appendRunEvent(root, runId, { type: "task_completed", task: taskId, attempt: state.attempt });
	} else {
		const categories = [...new Set(findings.map(categorize))].sort();
		routing = recordDefect(root, runId, {
			task: taskId,
			owner: task.owner,
			requirement: null,
			category: categories.length === 1 ? categories[0] : "other",
			reproduction: findings
				.map((finding) => finding.replace(/\(exit .*\)/, ""))
				.sort()
				.join("|"),
			changeDigest: sha256(`${state.start_tree}->${currentTree}`),
		});
		appendRunEvent(root, runId, { type: "task_failed", task: taskId, attempt: state.attempt });
		if (routing.decision === "blocked") blockRun(root, manifest);
	}
	writeJsonAtomic(taskStatePath(root, runId, taskId), {
		...state,
		state: accepted ? "completed" : "failed",
		end_tree: currentTree,
		delta: delta.paths,
		evidence: verification?.results.map((result) => result.check_id) ?? [],
		findings,
		finished_at: new Date().toISOString(),
	});
	return { ok: accepted, run_id: runId, task: taskId, delta: delta.paths, findings, routing, verification };
}

export function readyCommand(root, { runId }) {
	const manifest = readManifest(root, runId);
	const contract = planContract(root, manifest.spec);
	const states = allTaskStates(root, runId, contract);
	const currentTree = snapshotTree(root);
	const entries = readiness(contract, states, (node, state) =>
		completionIsValid(root, runId, node, state, currentTree),
	).map((entry) => ({
		...entry,
		conflicts:
			entry.blockers.length === 0 && entry.state !== "completed"
				? concurrencyConflicts(contract, states, entry.id)
				: [],
		defect_blocked: taskIsBlockedByDefects(root, runId, entry.id).length > 0,
	}));
	return {
		ok: true,
		run_id: runId,
		state: manifest.state,
		dispatchable: entries
			.filter(
				(entry) =>
					!["completed", "running"].includes(entry.state) &&
					entry.blockers.length === 0 &&
					entry.conflicts.length === 0 &&
					!entry.defect_blocked,
			)
			.map((entry) => entry.id),
		tasks: entries,
	};
}

export function failCommand(root, { runId, taskId, category, reproduction, requirement = null }) {
	const manifest = readManifest(root, runId);
	refuseCancelled(manifest);
	const task = planTask(root, manifest, taskId);
	const state = readTaskState(root, runId, taskId);
	if (!state) throw new Error(`${taskId} was not started in this run`);
	const currentTree = snapshotTree(root);
	const routing = recordDefect(root, runId, {
		task: taskId,
		owner: task.owner,
		requirement,
		category,
		reproduction,
		changeDigest: sha256(`${state.start_tree}->${currentTree}`),
	});
	releaseTaskLocks(root, runId, task);
	writeJsonAtomic(taskStatePath(root, runId, taskId), {
		...state,
		state: "failed",
		end_tree: currentTree,
		finished_at: new Date().toISOString(),
	});
	appendRunEvent(root, runId, { type: "task_failed", task: taskId, attempt: state.attempt });
	if (routing.decision === "blocked") blockRun(root, manifest);
	return { ok: true, run_id: runId, task: taskId, routing };
}

// Revalidates everything; never repeats an external effect on its own.
export function resumeCommand(root, { runId }) {
	let manifest;
	try {
		manifest = readManifest(root, runId);
	} catch (error) {
		return {
			ok: false,
			run_id: runId,
			state: "blocked",
			reason: `unrecoverable state (${error.message}); create a new run from the spec — earlier completions are unknown and the approval must be recorded again`,
		};
	}
	const contract = planContract(root, manifest.spec);
	const states = allTaskStates(root, runId, contract);
	const currentTree = snapshotTree(root);
	const approval = approvalStatus(root, manifest);
	const tasks = contract.nodes.map((node) => {
		const state = states[node.id];
		if (!state) return { id: node.id, state: "pending" };
		if (state.state === "completed") {
			const valid = completionIsValid(root, runId, node, state, currentTree);
			if (!valid) {
				writeJsonAtomic(taskStatePath(root, runId, node.id), {
					...state,
					state: "unknown",
					reason: "evidence unrecoverable or invalidated on resume",
				});
			}
			return { id: node.id, state: valid ? "completed" : "unknown" };
		}
		if (state.state === "running") {
			writeJsonAtomic(taskStatePath(root, runId, node.id), {
				...state,
				state: "unknown",
				reason: "interrupted while running; needs a new start",
			});
			return { id: node.id, state: "unknown" };
		}
		return { id: node.id, state: state.state };
	});
	if (!approval.valid && ["approved", "running"].includes(manifest.state)) {
		manifest = transition(manifest, "awaiting_approval");
		saveManifest(root, manifest);
	}
	appendRunEvent(root, runId, { type: "resumed" });
	return { ok: true, run_id: runId, state: manifest.state, approval, tasks };
}

// Ends a superseded run. It approves, accepts and reverts nothing: running
// tasks become `unknown`, the run's own locks are released, and the reason
// and what was left unaccepted are recorded.
export function cancelCommand(root, { runId, reason }) {
	let manifest = readManifest(root, runId);
	if (manifest.state === "cancelled") {
		return { ok: false, run_id: runId, state: manifest.state, reason: "run already cancelled" };
	}
	// Every task in the run directory, in the current plan or not. `running`,
	// `failed` and `unknown` have their delta exposed, never accepted; only
	// `running` becomes `unknown`.
	const tasksDir = join(runPath(root, runId), "tasks");
	const currentTree = snapshotTree(root);
	const unacceptedPaths = {};
	const markedUnknown = [];
	for (const file of existsSync(tasksDir) ? readdirSync(tasksDir).sort() : []) {
		if (!file.endsWith(".json")) continue;
		const path = join(tasksDir, file);
		let state;
		try {
			state = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			continue;
		}
		if (!["running", "failed", "unknown"].includes(state?.state)) continue;
		const id = state.task_id ?? file.slice(0, -5);
		let paths = null;
		try {
			if (state.start_tree) paths = treeDelta(root, state.start_tree, currentTree).paths;
		} catch {
			// An unrecoverable start tree: `null` says "unknown", never "nothing changed".
		}
		unacceptedPaths[id] = paths;
		if (state.state === "running") {
			writeJsonAtomic(path, { ...state, state: "unknown", reason: "run cancelled" });
			markedUnknown.push(id);
		}
	}
	// Every lock this run holds. `releaseLock` rereads the key's file and
	// refuses another holder, so a forged file releases nobody's lock.
	const released = [];
	const dir = locksDir(root);
	for (const file of existsSync(dir) ? readdirSync(dir).sort() : []) {
		if (!file.endsWith(".lock")) continue;
		let holder;
		try {
			holder = JSON.parse(readFileSync(join(dir, file), "utf8"));
		} catch {
			continue;
		}
		if (holder?.run_id !== runId || typeof holder.key !== "string") continue;
		let result;
		try {
			result = releaseLock(dir, holder.key, runId);
		} catch {
			continue;
		}
		if (result.released) {
			released.push(holder.key);
			appendRunEvent(root, runId, { type: "lock_released", key: holder.key });
		}
	}
	// Locks before state: if the process dies in between, the run is still
	// not terminal and `cancel` can be repeated.
	manifest = transition(manifest, "cancelled");
	saveManifest(root, manifest);
	appendRunEvent(root, runId, {
		type: "state_changed",
		to: "cancelled",
		reason,
		unaccepted_paths: unacceptedPaths,
	});
	return {
		ok: true,
		run_id: runId,
		state: manifest.state,
		released,
		unknown_tasks: markedUnknown.sort(),
		unaccepted_paths: unacceptedPaths,
	};
}

export function recoverLockCommand(root, { key }) {
	const result = recoverLock(locksDir(root), key);
	return { ok: result.recovered, key, ...result };
}

// --- Summary (`aria status`) ---------------------------------------------------

const REQUIREMENT_ID = /^R\d+(?:\.\d+)*$/;

// The most recent run by creation instant; ids alone only order by second.
export function latestRunId(root) {
	const dir = runsDir(root);
	const runs = (existsSync(dir) ? readdirSync(dir) : [])
		.filter((id) => RUN_ID_PATTERN.test(id))
		.map((id) => {
			try {
				return { id, at: Date.parse(readManifest(root, id).created_at) || 0 };
			} catch {
				return { id, at: 0 };
			}
		})
		.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
	return runs.at(-1)?.id ?? null;
}

// The latest recorded failure, keeping only fields whose shape is known: the
// defects file is run state, not trusted text.
function lastFailure(root, runId) {
	let defects;
	try {
		defects = readDefects(root, runId);
	} catch {
		return { task: null, category: "unavailable", attempts: null, requirement: null };
	}
	let latest = null;
	for (const entry of Object.values(defects)) {
		const attempts = Array.isArray(entry?.attempts) ? entry.attempts : [];
		const at = Date.parse(attempts.at(-1)?.at ?? "");
		if (!Number.isFinite(at)) continue;
		if (!latest || at > latest.at) latest = { at, entry, attempts: attempts.length };
	}
	if (!latest) return null;
	const { entry } = latest;
	return {
		task: TASK_ID_PATTERN.test(entry.task ?? "") ? entry.task : null,
		category: DEFECT_CATEGORIES.includes(entry.category) ? entry.category : "other",
		attempts: latest.attempts,
		requirement: REQUIREMENT_ID.test(entry.requirement ?? "") ? entry.requirement : null,
	};
}

function nextStep(runId, state, approval, tasks, dispatchable) {
	if (["cancelled", "failed", "blocked"].includes(state)) return `human decision: the run is ${state}`;
	if (state === "ready_for_review") return "ready for review: open the pull request";
	if (!approval.valid) {
		return `aria run plan ${runId}, then ask the owner to approve (only their click approves)`;
	}
	const running = tasks.find((task) => task.state === "running");
	if (running) return `aria run accept ${runId} ${running.id} <handoff.json> (or aria run fail)`;
	if (dispatchable.length > 0) return `aria run start ${runId} ${dispatchable[0]}`;
	if (tasks.every((task) => task.state === "completed")) return "all tasks accepted: run the final review";
	return "no task can be dispatched: see the blocked tasks";
}

// The agent type that runs a task's owner: the project's own agent
// (`.claude/agents/<owner>.md`) first, then the plugin's, which Claude Code
// names `aria-orchestrator:<owner>`. `lead` is the main session.
export function agentTypeFor(root, owner, pluginRoot = null) {
	if (owner === "lead" || !/^[a-z][a-z0-9_-]*$/.test(String(owner))) return owner;
	if (existsSync(join(root, ".claude", "agents", `${owner}.md`))) return owner;
	if (pluginRoot && existsSync(join(pluginRoot, "agents", `${owner}.md`))) return `aria-orchestrator:${owner}`;
	return owner;
}

export function summaryCommand(root, { runId, pluginRoot = null }) {
	const manifest = readManifest(root, runId);
	const contract = planContract(root, manifest.spec);
	const digest = planDigest(contract);
	const approval = approvalStatus(root, manifest);
	const view = readyCommand(root, { runId });
	const owners = Object.fromEntries(contract.nodes.map((node) => [node.id, node.owner]));
	const tasks = view.tasks.map((entry) => {
		const reasons = [...entry.blockers, ...entry.conflicts];
		if (entry.defect_blocked) reasons.push("attempt limit or no progress: human decision");
		return {
			id: entry.id,
			owner: owners[entry.id],
			agent_type: agentTypeFor(root, owners[entry.id], pluginRoot),
			state: entry.state,
			blocked: reasons.length > 0,
			reasons,
		};
	});
	// Dispatch needs a valid approval: without it nothing is dispatchable.
	const dispatchable = approval.valid && ["approved", "running"].includes(manifest.state) ? view.dispatchable : [];
	return {
		ok: true,
		run_id: runId,
		spec: manifest.spec,
		state: manifest.state,
		plan_digest: digest,
		approval: {
			valid: approval.valid,
			recorded: manifest.approval !== null,
			reasons: approval.reasons,
			prefix: digest.slice(0, APPROVAL_PREFIX_LENGTH),
		},
		tasks,
		dispatchable,
		last_failure: lastFailure(root, runId),
		next: nextStep(runId, manifest.state, approval, tasks, dispatchable),
	};
}

// --- The loop (`/loop`) ---------------------------------------------------------
//
// `select` names the one run the loop follows; `observe` is one tick. The
// loop never picks a spec from the backlog, approves, publishes or merges:
// a state that needs the owner stops it, and a state seen on the previous
// tick is `idle`, so nothing is repeated.

const LOOP_TARGET = "loop-target.json";
const STOP_STATES = ["planned", "awaiting_approval", "blocked", "failed", "cancelled"];

export function selectCommand(root, { runId, pr = null }) {
	const manifest = readManifest(root, runId);
	const target = {
		run_id: runId,
		spec: manifest.spec,
		branch: git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
		pr,
		selected_at: new Date().toISOString(),
	};
	writeJsonAtomic(join(ensureDir(join(root, STATE_DIR)), LOOP_TARGET), target);
	return { ok: true, target };
}

export function observeCommand(root, { head = null, checks = "unknown", pluginRoot = null }) {
	const targetPath = join(root, STATE_DIR, LOOP_TARGET);
	if (!existsSync(targetPath)) {
		return {
			ok: true,
			action: "stop",
			reason: "no run selected (aria run select <run-id> [--pr <n>]); the loop never picks work from the backlog",
		};
	}
	const target = JSON.parse(readFileSync(targetPath, "utf8"));
	if (!RUN_ID_PATTERN.test(String(target.run_id ?? ""))) throw new Error(`${STATE_DIR}/${LOOP_TARGET} names no valid run`);
	const summary = summaryCommand(root, { runId: target.run_id, pluginRoot });
	const observedHead = head ?? git(root, ["rev-parse", "HEAD"]);
	const key = sha256(
		JSON.stringify({
			state: summary.state,
			approval: summary.approval.valid,
			tasks: summary.tasks.map((task) => [task.id, task.state, task.blocked]),
			head: observedHead,
			checks,
		}),
	);
	const loopPath = join(runPath(root, target.run_id), "loop.json");
	const previous = existsSync(loopPath) ? JSON.parse(readFileSync(loopPath, "utf8")) : null;
	const changed = previous?.last_key !== key;
	writeJsonAtomic(loopPath, { last_key: key, observed_at: new Date().toISOString(), head: observedHead, checks });

	const pending = summary.tasks.filter((task) => task.state !== "completed");
	const running = summary.tasks.filter((task) => task.state === "running").map((task) => task.id);
	let action = "work";
	let reason = "the state changed and the approved plan has work";
	if (STOP_STATES.includes(summary.state)) {
		action = "stop";
		reason = ["planned", "awaiting_approval"].includes(summary.state)
			? `the run is ${summary.state}: only the owner's approval moves it`
			: `the run is ${summary.state}: a human decision is needed`;
	} else if (!summary.approval.valid) {
		action = "stop";
		reason = `the approval no longer holds (${summary.approval.reasons.join("; ")}): present the plan again`;
	} else if (summary.state === "ready_for_review" || pending.length === 0) {
		action = "stop";
		reason = "every task is accepted: ready for review";
	} else if (!changed) {
		action = "idle";
		reason = "same state as the previous tick: nothing to repeat";
	} else if (summary.dispatchable.length === 0 && running.length === 0) {
		action = "stop";
		reason = "no task can be dispatched: the blocked tasks need a decision";
	}
	return {
		ok: true,
		target,
		state: summary.state,
		changed,
		action,
		reason,
		dispatchable: action === "work" ? summary.dispatchable : [],
		running,
		checks,
		next: summary.next,
	};
}
