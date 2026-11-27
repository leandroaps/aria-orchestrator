import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
	appendApproval,
	appendRejection,
	claimEvent,
	consumePreCheckMark,
	createPreCheckMark,
	isApprovalLine,
	readRegistry,
	registryPath,
	resolveCommonDir,
} from "../lib/approval-registry.mjs";
import { loadConfig } from "../lib/config.mjs";
import {
	APPROVAL_MARKER_PATTERN,
	acquireLock,
	approvalProvenanceProblems,
	approvalStatus,
	concurrencyConflicts,
	createRun,
	externalResources,
	graphProblems,
	lockPath,
	planContract,
	planDigest,
	presentPlan,
	readDefects,
	readManifest,
	readiness,
	recordApproval,
	recordDefect,
	recoverLock,
	releaseLock,
	runPath,
	saveManifest,
	taskIsBlockedByDefects,
	transition,
	writeJsonAtomic,
} from "../lib/run-state.mjs";
import { PARALLEL_TASKS, SPEC, TASKS, git, workspace, writeFile } from "./helpers/workspace.mjs";

const HOOK_DIGEST = "a".repeat(64);

function newRun(root) {
	return createRun(root, {
		spec: SPEC,
		worktree: root,
		branch: "main",
		baseCommit: git(root, ["rev-parse", "HEAD"]),
	});
}

// Present the plan and write the human click to the registry, strictly after
// the presentation.
async function presentAndClick(root, runId, { approves, forRun = runId } = {}) {
	const { prefix } = presentPlan(root, runId);
	await sleep(5);
	return appendApproval(resolveCommonDir(root), {
		approves: approves ?? prefix,
		runId: forRun,
		hookDigest: HOOK_DIGEST,
	});
}

function record(root, runId, eventId) {
	return recordApproval(root, runId, {
		eventId,
		tasksBlob: git(root, ["rev-parse", `HEAD:specs/${SPEC}/tasks.md`]),
		headCommit: git(root, ["rev-parse", "HEAD"]),
		acceptedHookDigests: [HOOK_DIGEST],
	});
}

async function approvedRun(root) {
	const { run_id: runId } = newRun(root);
	const event = await presentAndClick(root, runId);
	return record(root, runId, event.id);
}

// --- Run manifest ----------------------------------------------------------

test("createRun records identity, spec, branch, base commit and plan digest", (t) => {
	const root = workspace(t);
	const manifest = newRun(root);
	assert.equal(manifest.state, "planned");
	assert.equal(manifest.spec, SPEC);
	assert.equal(manifest.branch, "main");
	assert.equal(manifest.base_commit, git(root, ["rev-parse", "HEAD"]));
	assert.equal(manifest.common_dir, resolveCommonDir(root));
	assert.equal(manifest.plan_digest, planDigest(planContract(root, SPEC)));
	assert.deepEqual(readManifest(root, manifest.run_id), manifest);
	assert.match(runPath(root, manifest.run_id), /\.aria\/runs\//);
});

test("the plan contract binds the config digest", (t) => {
	const root = workspace(t);
	const before = planDigest(planContract(root, SPEC));
	const config = JSON.parse(readFileSync(join(root, "aria.config.json"), "utf8"));
	config.agents.backend.allowedPaths.push("docs/**");
	writeFile(root, "aria.config.json", JSON.stringify(config));
	assert.notEqual(planDigest(planContract(root, SPEC)), before);
});

test("an evidence paragraph or a checkbox does not change the plan; a task body does", (t) => {
	const root = workspace(t);
	const path = join(root, "specs", SPEC, "tasks.md");
	const digest = () => planDigest(planContract(root, SPEC));
	const original = readFileSync(path, "utf8");
	const before = digest();
	writeFileSync(
		path,
		original
			.replace("- [ ] **T1**", "- [x] **T1**")
			.replace("Body of task T1.", "Body of task T1.\n\n  Done on 2026-11-27, commit abc."),
	);
	assert.equal(digest(), before);
	writeFileSync(path, original.replace("Body of task T1.", "Body of task T1, plus more."));
	assert.notEqual(digest(), before);
});

test("graphProblems reports unknown owners, missing dependencies and cycles", () => {
	const node = (id, depends_on, extra = {}) => ({ id, owner: "b", depends_on, ...extra });
	const problems = graphProblems({
		nodes: [
			node("T1", ["T2"]),
			node("T2", ["T1"]),
			node("T3", ["T9"], { unknown_owner: true, owner: "ghost" }),
		],
	});
	assert.ok(problems.includes('T3: unknown owner "ghost"'));
	assert.ok(problems.includes('T3: missing dependency "T9"'));
	assert.ok(problems.some((p) => p.startsWith("cycle: T1 → T2 → T1")));
});

test("createRun refuses an invalid graph and creates no state", (t) => {
	const root = workspace(t, { tasks: "- [ ] **T1** Ghost (`ghost`) → R1.1\n" });
	assert.throws(() => newRun(root), /invalid graph: T1: unknown owner/);
});

test("transitions: only allowed ones, and never directly to approved", (t) => {
	const root = workspace(t);
	const manifest = newRun(root);
	assert.throws(() => transition(manifest, "running"), /not allowed: planned → running/);
	assert.throws(
		() => transition({ ...manifest, state: "awaiting_approval" }, "approved"),
		/only reached through record-approval/,
	);
	assert.equal(transition(manifest, "cancelled").state, "cancelled");
});

test("a hand-edited or corrupted manifest is refused", (t) => {
	const root = workspace(t);
	const manifest = newRun(root);
	const path = join(runPath(root, manifest.run_id), "manifest.json");
	writeJsonAtomic(path, { ...manifest, state: "approved" });
	assert.throws(() => readManifest(root, manifest.run_id), /without an approval record/);
	writeFileSync(path, "{");
	assert.throws(() => readManifest(root, manifest.run_id), /corrupted manifest/);
	assert.throws(() => runPath(root, "../escape"), /invalid run id/);
});

// --- Approval --------------------------------------------------------------

test("the approval marker is the whole message, in either locale", () => {
	assert.equal(APPROVAL_MARKER_PATTERN.exec("approve 0123456789ab")[1], "0123456789ab");
	assert.ok(APPROVAL_MARKER_PATTERN.test("  aprovo 0123456789abcdef "));
	assert.ok(!APPROVAL_MARKER_PATTERN.test("I don't approve 0123456789ab"));
	assert.ok(!APPROVAL_MARKER_PATTERN.test("approve 0123456"));
});

test("a click on the presented prefix approves the run", async (t) => {
	const root = workspace(t);
	const manifest = await approvedRun(root);
	assert.equal(manifest.state, "approved");
	assert.deepEqual(approvalProvenanceProblems(root, manifest), []);
	assert.deepEqual(approvalStatus(root, manifest), { valid: true, reasons: [] });
});

test("without a human event the run is not approved", async (t) => {
	const root = workspace(t);
	const { run_id: runId } = newRun(root);
	presentPlan(root, runId);
	assert.throws(
		() => record(root, runId, "20261127T000000Z-00000000"),
		/not found or without an approval marker/,
	);
	assert.equal(readManifest(root, runId).state, "awaiting_approval");
});

test("approval requires a presented plan", async (t) => {
	const root = workspace(t);
	const { run_id: runId } = newRun(root);
	saveManifest(root, transition(readManifest(root, runId), "awaiting_approval"));
	assert.throws(() => record(root, runId, "20261127T000000Z-00000000"), /no plan presented/);
});

test("an event with the prefix of another digest is refused", async (t) => {
	const root = workspace(t);
	const { run_id: runId } = newRun(root);
	const event = await presentAndClick(root, runId, { approves: "0123456789ab" });
	assert.throws(() => record(root, runId, event.id), /does not match the last presented plan/);
});

test("an event for another run does not approve this one", async (t) => {
	const root = workspace(t);
	const first = newRun(root).run_id;
	const second = newRun(root).run_id;
	presentPlan(root, second);
	const event = await presentAndClick(root, first, { forRun: second });
	assert.throws(() => record(root, first, event.id), /approved run .* not/);
});

test("an event written by an unversioned hook is refused", async (t) => {
	const root = workspace(t);
	const { run_id: runId } = newRun(root);
	const event = await presentAndClick(root, runId);
	assert.throws(
		() =>
			recordApproval(root, runId, {
				eventId: event.id,
				tasksBlob: "x",
				headCommit: "y",
				acceptedHookDigests: ["b".repeat(64)],
			}),
		/question hook other than the versioned one/,
	);
});

test("an event earlier than the last presentation is refused", async (t) => {
	const root = workspace(t);
	const { run_id: runId } = newRun(root);
	const event = await presentAndClick(root, runId);
	await sleep(5);
	presentPlan(root, runId);
	assert.throws(() => record(root, runId, event.id), /predates the last presentation/);
});

test("a plan changed after its presentation must be presented again", async (t) => {
	const root = workspace(t);
	const { run_id: runId } = newRun(root);
	const event = await presentAndClick(root, runId);
	const path = join(root, "specs", SPEC, "tasks.md");
	writeFileSync(path, readFileSync(path, "utf8").replace("Body of task T2.", "Wider T2."));
	assert.throws(() => record(root, runId, event.id), /present it again/);
});

test("an event already consumed by another run is refused", async (t) => {
	const root = workspace(t);
	const { run_id: runId } = newRun(root);
	const event = await presentAndClick(root, runId);
	claimEvent(resolveCommonDir(root), event.id, "20261127T000000Z-abcdef");
	assert.throws(() => record(root, runId, event.id), /already approved another run/);
});

test("widening a task body or its allowed_paths after approval voids it", async (t) => {
	for (const [from, to] of [
		["Body of task T2.", "Body of task T2, and also delete the database."],
		["  allowed_paths:\n    - src/lib/**\n  verification:\n    - node tools/check.mjs\n  ```\n\n- [ ] **T3**", "  allowed_paths:\n    - src/**\n  verification:\n    - node tools/check.mjs\n  ```\n\n- [ ] **T3**"],
	]) {
		const root = workspace(t);
		const manifest = await approvedRun(root);
		const path = join(root, "specs", SPEC, "tasks.md");
		const source = readFileSync(path, "utf8");
		assert.ok(source.includes(from), `fixture contains ${JSON.stringify(from)}`);
		writeFileSync(path, source.replace(from, to));
		const status = approvalStatus(root, manifest);
		assert.equal(status.valid, false);
		assert.ok(status.reasons.some((r) => r.includes("differs from the approved one")));
	}
});

test("changing .claude/settings.json after approval voids it", async (t) => {
	const root = workspace(t);
	const manifest = await approvedRun(root);
	writeFile(root, ".claude/settings.json", '{ "hooks": { "PreToolUse": [] } }\n');
	assert.deepEqual(approvalStatus(root, manifest).reasons, [
		".claude/settings.json changed after the approval",
	]);
	assert.equal(
		approvalStatus(root, manifest, { plannedControlEdits: [".claude/settings.json"] }).valid,
		true,
	);
});

test("an approval forged in the manifest has no provenance", async (t) => {
	const root = workspace(t);
	const { run_id: runId } = newRun(root);
	const { digest } = presentPlan(root, runId);
	const forged = {
		...readManifest(root, runId),
		state: "approved",
		approval: {
			event_id: "20261127T000000Z-00000000",
			digest,
			base_commit: "x",
			tasks_blob: "y",
			recorded_at: new Date().toISOString(),
		},
	};
	saveManifest(root, forged);
	const problems = approvalProvenanceProblems(root, forged);
	assert.ok(problems.includes("approval in the manifest without an `approval_recorded` event"));
	assert.ok(problems.includes("approval without a matching human event"));
	assert.equal(approvalStatus(root, forged).valid, false);
});

test("an approval loses provenance when the event's consumption is missing", async (t) => {
	const root = workspace(t);
	const manifest = await approvedRun(root);
	const consumed = join(
		resolveCommonDir(root),
		"aria",
		"consumed",
		`${manifest.approval.event_id}.json`,
	);
	writeFileSync(consumed, `${JSON.stringify({ run_id: "20261127T000000Z-abcdef" })}\n`);
	assert.ok(
		approvalProvenanceProblems(root, manifest).includes(
			"approval event without a consumption recorded for this run",
		),
	);
});

// --- Registry ----------------------------------------------------------------

test("registry lines need the exact key set of their type", (t) => {
	const root = workspace(t);
	const commonDir = resolveCommonDir(root);
	const good = appendApproval(commonDir, {
		approves: "0123456789ab",
		runId: "20261127T000000Z-abcdef",
		hookDigest: HOOK_DIGEST,
	});
	appendRejection(commonDir, { source: "UserPromptSubmit", reason: "source_not_user" });
	const lines = [
		{ ...good, extra: 1 },
		{ ...good, rejected: "subagent" },
		{ ...good, source: "UserPromptSubmit" },
		"garbage",
	];
	writeFileSync(
		registryPath(commonDir),
		`${readFileSync(registryPath(commonDir), "utf8")}${lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`,
	);
	const registry = readRegistry(commonDir);
	assert.equal(registry.approvals.length, 1);
	assert.equal(registry.rejections.length, 1);
	assert.equal(registry.invalidLines, 4);
	assert.ok(!isApprovalLine({ ...good, approves: "0123456" }));
	assert.throws(
		() => appendRejection(commonDir, { source: "UserPromptSubmit", reason: "because" }),
		/out of shape/,
	);
});

test("the registry is shared by linked worktrees", async (t) => {
	const root = workspace(t);
	const linked = `${root}-linked`;
	git(root, ["worktree", "add", "-q", linked]);
	t.after(() => rmSync(linked, { recursive: true, force: true }));
	assert.equal(resolveCommonDir(linked), resolveCommonDir(root));
	assert.equal(resolveCommonDir("relative/path"), null);
	// A click recorded from the linked worktree approves the main one's run.
	const { run_id: runId } = newRun(root);
	const { prefix } = presentPlan(root, runId);
	await sleep(5);
	const event = appendApproval(resolveCommonDir(linked), {
		approves: prefix,
		runId,
		hookDigest: HOOK_DIGEST,
	});
	assert.equal(record(root, runId, event.id).state, "approved");
});

test("the PreToolUse mark is valid once, for the same session and tool use", (t) => {
	const root = workspace(t);
	const commonDir = resolveCommonDir(root);
	createPreCheckMark(commonDir, "session-1", "tool-1");
	assert.throws(() => createPreCheckMark(commonDir, "session-1", "tool-1"), /EEXIST/);
	assert.equal(consumePreCheckMark(commonDir, "session-2", "tool-1"), false);
	assert.equal(consumePreCheckMark(commonDir, "session-1", "tool-1"), true);
	assert.equal(consumePreCheckMark(commonDir, "session-1", "tool-1"), false);
	assert.equal(consumePreCheckMark(commonDir, "../x", "tool-1"), false);
});

// --- Dispatch and concurrency ----------------------------------------------

function parallelContract(t) {
	const root = workspace(t, { tasks: PARALLEL_TASKS });
	return { root, contract: planContract(root, SPEC) };
}

const running = (...ids) =>
	Object.fromEntries(ids.map((id) => [id, { task_id: id, state: "running" }]));

test("a task whose dependency is not completed is not ready", (t) => {
	const { contract } = parallelContract(t);
	const ready = readiness(contract, {}, () => true);
	assert.deepEqual(ready.find((r) => r.id === "T2").blockers, ["T1 not completed"]);
	const done = { T1: { task_id: "T1", state: "completed" } };
	assert.deepEqual(readiness(contract, done, () => true).find((r) => r.id === "T2").blockers, []);
	assert.deepEqual(
		readiness(contract, done, () => false).find((r) => r.id === "T2").blockers,
		["T1 has invalidated evidence"],
	);
});

test("concurrency: at most three, one per owner, no shared territory or resource", (t) => {
	const { contract } = parallelContract(t);
	assert.deepEqual(concurrencyConflicts(contract, running("T1", "T3"), "T9"), []);
	assert.match(
		concurrencyConflicts(contract, running("T1", "T3", "T9"), "T10").join(";"),
		/3 tasks already running/,
	);
	assert.match(concurrencyConflicts(contract, running("T1"), "T5").join(";"), /same owner "backend"/);
	assert.match(concurrencyConflicts(contract, running("T1"), "T10").join(";"), /territory shared with T1/);
	assert.match(
		concurrencyConflicts(contract, running("T3"), "T4").join(";"),
		/exclusive resource port:3000 in use by T3/,
	);
});

test("external resources come from the config", (t) => {
	const { root, contract } = parallelContract(t);
	const t7 = contract.nodes.find((n) => n.id === "T7");
	const t3 = contract.nodes.find((n) => n.id === "T3");
	assert.deepEqual(externalResources(t7, loadConfig(root)), ["neon:test"]);
	assert.deepEqual(externalResources(t3, loadConfig(root)), []);
});

// --- Defects -----------------------------------------------------------------

test("the third failure of the same defect blocks", (t) => {
	const root = workspace(t);
	const { run_id: runId } = newRun(root);
	const defect = (n) => ({
		task: "T1",
		owner: "backend",
		requirement: "R1.1",
		category: "verification_failed",
		reproduction: "node tools/check.mjs fails",
		changeDigest: `change-${n}`,
	});
	assert.equal(recordDefect(root, runId, defect(1)).decision, "route_to_owner");
	assert.equal(recordDefect(root, runId, defect(2)).decision, "route_to_owner");
	const third = recordDefect(root, runId, defect(3));
	assert.equal(third.decision, "blocked");
	assert.equal(third.attempts, 3);
	assert.equal(taskIsBlockedByDefects(root, runId, "T1").length, 1);
});

test("two failures in a row with the same content block before the third", (t) => {
	const root = workspace(t);
	const { run_id: runId } = newRun(root);
	const defect = {
		task: "T1",
		category: "delta_mismatch",
		reproduction: "x",
		changeDigest: "same",
	};
	recordDefect(root, runId, defect);
	const second = recordDefect(root, runId, defect);
	assert.equal(second.decision, "blocked");
	assert.match(second.reason, /no progress/);
});

test("rewording a reproduction (case, spaces, hashes) does not reset the counter", (t) => {
	const root = workspace(t);
	const { run_id: runId } = newRun(root);
	const base = { task: "T1", category: "verification_failed" };
	const a = recordDefect(root, runId, { ...base, reproduction: "Check FAILS at 0123456789abcdef" });
	const b = recordDefect(root, runId, { ...base, reproduction: "check   fails at fedcba9876543210" });
	assert.equal(a.defect_key, b.defect_key);
	assert.equal(b.attempts, 2);
	const c = recordDefect(root, runId, { ...base, reproduction: "a different failure" });
	assert.notEqual(c.defect_key, a.defect_key);
	assert.equal(Object.keys(readDefects(root, runId)).length, 2);
	assert.throws(() => recordDefect(root, runId, { ...base, category: "bad" }), /unknown defect category/);
});

// --- Locks -------------------------------------------------------------------

test("locks: exclusive, reentrant for the same run, released only by their run", (t) => {
	const root = workspace(t);
	const locks = join(resolveCommonDir(root), "aria", "locks");
	const owner = { run_id: "20261127T000000Z-aaaaaa", worktree: root };
	assert.equal(acquireLock(locks, "resource:port:3000", owner).acquired, true);
	assert.equal(acquireLock(locks, "resource:port:3000", owner).reentrant, true);
	const other = acquireLock(locks, "resource:port:3000", { ...owner, run_id: "20261127T000000Z-bbbbbb" });
	assert.equal(other.acquired, false);
	assert.equal(other.holder.run_id, owner.run_id);
	assert.equal(releaseLock(locks, "resource:port:3000", "20261127T000000Z-bbbbbb").released, false);
	assert.equal(releaseLock(locks, "resource:port:3000", owner.run_id).released, true);
	assert.throws(() => acquireLock(locks, "Bad Key", owner), /invalid lock key/);
});

test("recoverLock keeps a lock whose holder is running and frees it once finished", (t) => {
	const root = workspace(t);
	const locks = join(resolveCommonDir(root), "aria", "locks");
	const manifest = newRun(root);
	const owner = { run_id: manifest.run_id, task_id: "T1", worktree: root };
	acquireLock(locks, "resource:port:3000", owner);
	const tasksDir = join(runPath(root, manifest.run_id), "tasks");
	mkdirSync(tasksDir, { recursive: true });
	writeJsonAtomic(join(tasksDir, "T1.json"), { task_id: "T1", state: "running" });
	const kept = recoverLock(locks, "resource:port:3000");
	assert.equal(kept.recovered, false);
	assert.match(kept.reason, /still running: lock kept/);
	writeJsonAtomic(join(tasksDir, "T1.json"), { task_id: "T1", state: "unknown" });
	assert.equal(recoverLock(locks, "resource:port:3000").recovered, true);
});

test("a lock held on another host is never recovered", (t) => {
	const root = workspace(t);
	const locks = join(resolveCommonDir(root), "aria", "locks");
	const manifest = newRun(root);
	acquireLock(locks, "worktree:main", { run_id: manifest.run_id, worktree: root });
	saveManifest(root, transition(manifest, "cancelled"));
	const path = lockPath(locks, "worktree:main");
	const record = JSON.parse(readFileSync(path, "utf8"));
	writeFileSync(path, JSON.stringify({ ...record, host: "elsewhere.example" }));
	const result = recoverLock(locks, "worktree:main");
	assert.equal(result.recovered, false);
	assert.match(result.reason, /another host/);
});
