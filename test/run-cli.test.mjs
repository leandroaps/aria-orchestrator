// `aria run <command>`: the run controller behind the command line. The tests
// call `main` in-process so they can hand it a plugin root whose question
// hook they know; the real binary always uses its own plugin directory.


import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { approvalQuestion } from "../lib/approval-template.mjs";
import { HANDOFF_T1, aria, approvedRun, create, handoff, presentAndClick, run } from "./helpers/run-cli.mjs";
import { SPEC, git, workspace, writeFile } from "./helpers/workspace.mjs";

// --- create, plan, status -----------------------------------------------------

test("run create: a planned run for the spec, with its identity", (t) => {
	const root = workspace(t);
	const result = run(root, ["create", "0001"]);
	assert.equal(result.code, 0, result.stderr);
	const { ok, run: manifest } = result.json();
	assert.equal(ok, true);
	assert.equal(manifest.spec, SPEC);
	assert.equal(manifest.state, "planned");
	assert.equal(manifest.branch, "main");
	assert.equal(manifest.base_commit, git(root, ["rev-parse", "HEAD"]));
	assert.equal(manifest.worktree, root);
});

test("run create: an unknown spec is a usage error", (t) => {
	const root = workspace(t);
	const result = run(root, ["create", "9999"]);
	assert.equal(result.code, 2);
	assert.match(result.stderr, /no spec matches "9999"/);
});

test("run plan: moves to awaiting_approval and gives the approval prefix", (t) => {
	const root = workspace(t);
	const runId = create(root);
	const result = run(root, ["plan", runId]);
	assert.equal(result.code, 0);
	const plan = result.json();
	assert.equal(plan.state, "awaiting_approval");
	assert.match(plan.approval_prefix, /^[0-9a-f]{12}$/);
	assert.ok(plan.plan_digest.startsWith(plan.approval_prefix));
	assert.match(plan.instruction, /AskUserQuestion/);
	// The exact question the hook accepts, in the config's locale.
	assert.deepEqual(plan.approval_question, approvalQuestion({ runId, spec: SPEC, prefix: plan.approval_prefix }, "en"));
	assert.deepEqual(
		plan.tasks.map((task) => [task.id, task.owner, task.depends_on]),
		[
			["T1", "backend", []],
			["T2", "backend", ["T1"]],
			["T3", "backend", []],
		],
	);
});

test("run status: state, plan digests and approval", (t) => {
	const root = workspace(t);
	const runId = create(root);
	const status = run(root, ["status", runId]).json();
	assert.equal(status.state, "planned");
	assert.equal(status.spec, SPEC);
	assert.equal(status.plan_digest_current, status.plan_digest_recorded);
	assert.equal(status.approval, null);
	assert.equal(status.invalid_event_lines, 0);
});

test("run status: plain output names the run, its spec and its state", (t) => {
	const root = workspace(t);
	const runId = create(root);
	const result = aria(["run", "status", runId], { cwd: root });
	assert.equal(result.code, 0);
	assert.match(result.stdout, new RegExp(`^Run ${runId} \\(${SPEC}\\): planned$`, "m"));
	assert.match(result.stdout, /^approval: none$/m);
	assert.doesNotMatch(result.stdout, /\x1b/);
});

test("a malformed run id or task id is a usage error", (t) => {
	const root = workspace(t);
	assert.equal(run(root, ["status", "../../etc"]).code, 2);
	const runId = create(root);
	assert.equal(run(root, ["start", runId, "T1;rm"]).code, 2);
});

test("an unknown run is refused with exit 1", (t) => {
	const root = workspace(t);
	const result = run(root, ["status", "20260101T000000Z-abcdef"]);
	assert.equal(result.code, 1);
	assert.equal(result.json().ok, false);
	assert.match(result.json().error, /no manifest/);
});

// --- record-approval ------------------------------------------------------------

test("record-approval: the owner's click approves the presented plan", async (t) => {
	const root = workspace(t);
	const runId = create(root);
	const event = await presentAndClick(root, runId);
	const result = run(root, ["record-approval", runId]);
	assert.equal(result.code, 0, result.stdout);
	assert.equal(result.json().state, "approved");
	assert.equal(result.json().approval.event_id, event.id);
	const status = run(root, ["status", runId]).json();
	assert.equal(status.approval.valid, true);
});

test("record-approval: without a click it says where it looked", (t) => {
	const root = workspace(t);
	const runId = create(root);
	const { approval_prefix: prefix } = run(root, ["plan", runId]).json();
	const result = run(root, ["record-approval", runId]);
	assert.equal(result.code, 1);
	assert.match(result.json().error, new RegExp(`no approval event for ${prefix} in .*approval-events\\.jsonl`));
	assert.match(result.json().error, /still awaiting_approval/);
});

test("record-approval: an event written by another question hook does not approve", async (t) => {
	const root = workspace(t);
	const runId = create(root);
	const event = await presentAndClick(root, runId, { hookDigest: "b".repeat(64) });
	const result = run(root, ["record-approval", runId, "--event", event.id]);
	assert.equal(result.code, 1);
	assert.match(result.json().error, /question hook/);
});

test("record-approval: refused while the plugin has no question hook", async (t) => {
	const root = workspace(t);
	const runId = create(root);
	await presentAndClick(root, runId);
	const empty = realpathSync(mkdtempSync(join(tmpdir(), "aria-plugin-")));
	t.after(() => rmSync(empty, { recursive: true, force: true }));
	const result = run(root, ["record-approval", runId], { pluginRoot: empty });
	assert.equal(result.code, 1);
	assert.match(result.json().error, /hooks\/question-hook\.mjs/);
});

test("record-approval and cancel only act on the repository of the current directory", async (t) => {
	const root = workspace(t);
	const elsewhere = workspace(t);
	const runId = create(root);
	await presentAndClick(root, runId);
	for (const argv of [
		["record-approval", runId],
		["cancel", runId, "--reason", "superseded"],
	]) {
		const result = run(elsewhere, [...argv, "--root", root]);
		assert.equal(result.code, 1, argv[0]);
		assert.match(result.json().error, /--root/);
	}
	assert.equal(run(root, ["status", runId]).json().state, "awaiting_approval");
});

// --- start, verify, accept, ready ---------------------------------------------

test("run start: refused before the approval", (t) => {
	const root = workspace(t);
	const runId = create(root);
	run(root, ["plan", runId]);
	const result = run(root, ["start", runId, "T1"]);
	assert.equal(result.code, 1);
	assert.match(result.json().error, /approval/);
});

test("start, accept and ready: the full path of one task", async (t) => {
	const root = workspace(t);
	const runId = await approvedRun(root);

	const started = run(root, ["start", runId, "T1"]);
	assert.equal(started.code, 0, started.stdout);
	assert.equal(started.json().attempt, 1);
	assert.equal(run(root, ["status", runId]).json().state, "running");

	// T2 depends on T1, which is not accepted yet.
	const early = run(root, ["start", runId, "T2"]);
	assert.equal(early.code, 1);
	assert.match(early.json().error, /T2 is not ready: T1 not completed/);

	writeFile(root, "src/lib/new.txt", "new\n");
	const accepted = run(root, ["accept", runId, "T1", handoff(root, "t1.json", HANDOFF_T1)]);
	assert.equal(accepted.code, 0, accepted.stdout);
	assert.deepEqual(accepted.json().delta, ["src/lib/new.txt"]);
	assert.deepEqual(accepted.json().findings, []);
	assert.equal(accepted.json().verification.passed, true);

	const ready = run(root, ["ready", runId]).json();
	assert.deepEqual(ready.dispatchable, ["T2", "T3"]);
	assert.equal(ready.tasks.find((task) => task.id === "T1").state, "completed");
});

test("run accept: a handoff that hides a change is refused and routed to the owner", async (t) => {
	const root = workspace(t);
	const runId = await approvedRun(root);
	run(root, ["start", runId, "T1"]);
	writeFile(root, "src/lib/new.txt", "new\n");
	writeFile(root, "src/lib/hidden.txt", "hidden\n");
	const result = run(root, ["accept", runId, "T1", handoff(root, "t1.json", HANDOFF_T1)]);
	assert.equal(result.code, 1);
	const body = result.json();
	assert.equal(body.ok, false);
	assert.deepEqual(body.findings, ["changed file missing from the handoff: src/lib/hidden.txt"]);
	assert.equal(body.routing.decision, "route_to_owner");
	assert.equal(body.routing.category, "delta_mismatch");
	assert.equal(body.verification, null);
	const state = JSON.parse(readFileSync(join(root, ".aria/runs", runId, "tasks/T1.json"), "utf8"));
	assert.equal(state.state, "failed");
});

test("run accept: an unreadable handoff is a usage error", async (t) => {
	const root = workspace(t);
	const runId = await approvedRun(root);
	run(root, ["start", runId, "T1"]);
	assert.equal(run(root, ["accept", runId, "T1", join(root, "missing.json")]).code, 2);
});

test("run verify: runs the plan's checks on the current tree", async (t) => {
	const root = workspace(t);
	const runId = await approvedRun(root);
	run(root, ["start", runId, "T1"]);
	writeFile(root, "src/lib/flag.txt", "FAIL\n");
	const result = run(root, ["verify", runId, "T1"]);
	assert.equal(result.code, 1);
	const [check] = result.json().results;
	assert.equal(check.check_id, "T1-a1-c1");
	assert.equal(check.command, "node tools/check.mjs");
	assert.equal(check.passed, false);
	assert.match(check.output_tail, /fixture check: FAIL/);
	// The output tail is returned, never persisted.
	const stored = JSON.parse(readFileSync(join(root, ".aria/runs", runId, "evidence/T1-a1-c1.json"), "utf8"));
	assert.equal(stored.output_tail, undefined);
	assert.match(stored.output_digest, /^[0-9a-f]{64}$/);
});

test("run verify: plain output shows each check and the failing output", async (t) => {
	const root = workspace(t);
	const runId = await approvedRun(root);
	run(root, ["start", runId, "T1"]);
	writeFile(root, "src/lib/flag.txt", "FAIL\n");
	const result = aria(["run", "verify", runId, "T1"], { cwd: root });
	assert.equal(result.code, 1);
	assert.match(result.stdout, /^ {2}fail {2}node tools\/check\.mjs$/m);
	assert.match(result.stdout, /fixture check: FAIL/);
	assert.match(result.stdout, /^T1: verification failed\.$/m);
});

// --- fail, resume, cancel, recover-lock -------------------------------------

test("run fail: the third failure of the same defect blocks the run", async (t) => {
	const root = workspace(t);
	const runId = await approvedRun(root);
	let routing;
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		assert.equal(run(root, ["start", runId, "T3"]).code, 0, `start ${attempt}`);
		writeFile(root, "src/lib/attempt.txt", `${attempt}\n`);
		const failed = run(root, ["fail", runId, "T3", "--category", "other", "--repro", "flaky"]);
		assert.equal(failed.code, 0);
		routing = failed.json().routing;
	}
	assert.equal(routing.decision, "blocked");
	assert.equal(run(root, ["status", runId]).json().state, "blocked");
	assert.match(run(root, ["start", runId, "T1"]).json().error, /run in "blocked"/);
});

test("run fail: an unknown category is a usage error", async (t) => {
	const root = workspace(t);
	const runId = await approvedRun(root);
	run(root, ["start", runId, "T3"]);
	assert.equal(run(root, ["fail", runId, "T3", "--category", "bogus", "--repro", "x"]).code, 2);
	assert.equal(run(root, ["fail", runId, "T3", "--category", "other"]).code, 2);
});

test("run resume: a task interrupted while running becomes unknown", async (t) => {
	const root = workspace(t);
	const runId = await approvedRun(root);
	run(root, ["start", runId, "T1"]);
	const result = run(root, ["resume", runId]);
	assert.equal(result.code, 0);
	assert.deepEqual(
		result.json().tasks.map((task) => [task.id, task.state]),
		[
			["T1", "unknown"],
			["T2", "pending"],
			["T3", "pending"],
		],
	);
	assert.equal(result.json().approval.valid, true);
	// A new start numbers the attempt after the interrupted one.
	assert.equal(run(root, ["start", runId, "T1"]).json().attempt, 2);
});

test("run cancel: releases the run's locks and stops every later command", async (t) => {
	const root = workspace(t);
	const runId = await approvedRun(root);
	run(root, ["start", runId, "T1"]);
	writeFile(root, "src/lib/new.txt", "new\n");
	assert.equal(run(root, ["cancel", runId]).code, 2);
	const result = run(root, ["cancel", runId, "--reason", "superseded by a new spec"]);
	assert.equal(result.code, 0, result.stdout);
	const body = result.json();
	assert.equal(body.state, "cancelled");
	assert.equal(body.released.length, 1);
	assert.match(body.released[0], /^worktree:/);
	assert.deepEqual(body.unknown_tasks, ["T1"]);
	assert.deepEqual(body.unaccepted_paths, { T1: ["src/lib/new.txt"] });
	for (const argv of [["plan", runId], ["start", runId, "T3"], ["verify", runId, "T1"]]) {
		const later = run(root, argv);
		assert.equal(later.code, 1, argv[0]);
		assert.match(later.json().error, /cancelled/);
	}
	const again = run(root, ["cancel", runId, "--reason", "twice"]);
	assert.equal(again.code, 1);
	assert.equal(again.json().reason, "run already cancelled");
});

test("run recover-lock: a lock nobody holds is not recovered", (t) => {
	const root = workspace(t);
	const result = run(root, ["recover-lock", "resource:port:3000"]);
	assert.equal(result.code, 1);
	assert.equal(result.json().recovered, false);
	assert.equal(result.json().reason, "no such lock");
	assert.equal(run(root, ["recover-lock", "not a key"]).code, 2);
});

test("run recover-lock: frees the worktree lock of a run that ended without releasing it", async (t) => {
	const root = workspace(t);
	const runId = await approvedRun(root);
	assert.equal(run(root, ["start", runId, "T3"]).code, 0);
	const key = `worktree:${createHash("sha256").update(root).digest("hex").slice(0, 16)}`;
	// While the run is live, the lock is kept.
	const kept = run(root, ["recover-lock", key]);
	assert.equal(kept.code, 1);
	assert.match(kept.json().reason, /lock kept/);
	// The run ends without releasing it (a crash between the two writes).
	const manifestPath = join(root, ".aria/runs", runId, "manifest.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	writeFile(root, join(".aria/runs", runId, "manifest.json"), JSON.stringify({ ...manifest, state: "failed" }));
	const recovered = run(root, ["recover-lock", key]);
	assert.equal(recovered.code, 0, recovered.stdout);
	assert.equal(recovered.json().recovered, true);
	assert.equal(recovered.json().previous.run_id, runId);
});

// P7 round 3 (B4): after the final review passed, the run stayed `running`,
// and no command moved it on.
test("run close: once every task is accepted and committed, the run is ready for review", async (t) => {
	const root = workspace(t);
	const runId = await approvedRun(root);

	const early = run(root, ["close", runId]);
	assert.equal(early.code, 1);
	assert.match(early.json().reason, /not accepted: T1, T2, T3/);

	run(root, ["start", runId, "T1"]);
	writeFile(root, "src/lib/new.txt", "new\n");
	assert.equal(run(root, ["accept", runId, "T1", handoff(root, "t1.json", HANDOFF_T1)]).code, 0);
	run(root, ["start", runId, "T2"]);
	writeFile(root, "src/lib/more.txt", "more\n");
	const t2 = { ...HANDOFF_T1, task: "T2", changed_files: ["src/lib/more.txt"], requirements: { "R1.2": "ok" }, evidence: { "R1.2": "node tools/check.mjs" } };
	assert.equal(run(root, ["accept", runId, "T2", handoff(root, "t2.json", t2)]).code, 0);
	run(root, ["start", runId, "T3"]);
	const t3 = { ...HANDOFF_T1, task: "T3", changed_files: [], requirements: { "R1.3": "ok" }, evidence: { "R1.3": "node tools/check.mjs" } };
	assert.equal(run(root, ["accept", runId, "T3", handoff(root, "t3.json", t3)]).code, 0);

	// The accepted change is still in the working tree: not ready yet.
	const uncommitted = run(root, ["close", runId]);
	assert.equal(uncommitted.code, 1);
	assert.deepEqual(uncommitted.json().uncommitted, ["src/lib/more.txt", "src/lib/new.txt"]);
	assert.equal(run(root, ["status", runId]).json().state, "running");

	git(root, ["add", "-A"]);
	git(root, ["commit", "-q", "-m", "accepted change"]);
	const closed = run(root, ["close", runId]);
	assert.equal(closed.code, 0, closed.stdout);
	assert.equal(closed.json().state, "ready_for_review");
	assert.equal(run(root, ["status", runId]).json().state, "ready_for_review");

	const again = run(root, ["close", runId]);
	assert.equal(again.code, 1);
	assert.match(again.json().reason, /already ready_for_review/);
});

test("aria --help lists the run commands", () => {
	const result = aria(["--help"], { cwd: process.cwd() });
	assert.equal(result.code, 0);
	for (const command of [
		"create",
		"plan",
		"status",
		"record-approval",
		"start",
		"verify",
		"accept",
		"ready",
		"fail",
		"resume",
		"recover-lock",
		"cancel",
		"close",
	]) {
		assert.match(result.stdout, new RegExp(`run ${command}\\b`), command);
	}
});
