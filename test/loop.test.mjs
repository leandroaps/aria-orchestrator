// `aria run select` and `aria run observe`: what `/loop` follows, one
// observation per tick. The loop never picks work from the backlog.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { HANDOFF_T1, approvedRun, create, handoff, run } from "./helpers/run-cli.mjs";
import { SPEC, workspace, writeFile } from "./helpers/workspace.mjs";

function observe(root, argv = ["--checks", "none"]) {
	const result = run(root, ["observe", ...argv]);
	assert.equal(result.code, 0, result.stdout + result.stderr);
	return result.json();
}

test("without a selected run the loop stops", (t) => {
	const root = workspace(t);
	const result = observe(root);
	assert.equal(result.action, "stop");
	assert.match(result.reason, /no run selected/);
});

test("select records the run, its spec, the branch and the pull request", async (t) => {
	const root = workspace(t);
	const runId = await approvedRun(root);
	const result = run(root, ["select", runId, "--pr", "42"]);
	assert.equal(result.code, 0, result.stdout + result.stderr);
	const target = JSON.parse(readFileSync(join(root, ".aria", "loop-target.json"), "utf8"));
	assert.deepEqual(
		{ run_id: target.run_id, spec: target.spec, branch: target.branch, pr: target.pr },
		{ run_id: runId, spec: SPEC, branch: "main", pr: 42 },
	);
	assert.deepEqual(result.json().target.run_id, runId);
});

test("select refuses a run that does not exist and a pull request that is not a number", async (t) => {
	const root = workspace(t);
	const runId = await approvedRun(root);
	assert.equal(run(root, ["select", "20990101T000000Z-aaaaaa"]).code, 1);
	assert.equal(run(root, ["select", runId, "--pr", "abc"]).code, 2);
});

test("an approved run: work, then idle while nothing changes, then work again", async (t) => {
	const root = workspace(t);
	const runId = await approvedRun(root);
	run(root, ["select", runId]);
	const first = observe(root);
	assert.equal(first.action, "work");
	assert.deepEqual(first.dispatchable, ["T1", "T3"]);
	assert.equal(observe(root).action, "idle");
	// New checks on the same head are a change.
	assert.equal(observe(root, ["--checks", "test=failure"]).action, "work");
	assert.equal(observe(root, ["--checks", "test=failure"]).action, "idle");
	// So is a task moving.
	assert.equal(run(root, ["start", runId, "T1"]).code, 0);
	const moved = observe(root, ["--checks", "test=failure"]);
	assert.equal(moved.action, "work");
	assert.deepEqual(moved.running, ["T1"]);
});

test("a run awaiting approval stops the loop: only the owner can approve", (t) => {
	const root = workspace(t);
	const runId = create(root);
	run(root, ["select", runId]);
	const result = observe(root);
	assert.equal(result.action, "stop");
	assert.match(result.reason, /approval/);
	assert.deepEqual(result.dispatchable, []);
});

test("a run whose approval was voided stops the loop", async (t) => {
	const root = workspace(t);
	const runId = await approvedRun(root);
	run(root, ["select", runId]);
	const tasks = readFileSync(join(root, "specs", SPEC, "tasks.md"), "utf8").replace("Body of task T1.", "Body of task T1, changed.");
	writeFile(root, `specs/${SPEC}/tasks.md`, tasks);
	const result = observe(root);
	assert.equal(result.action, "stop");
	assert.match(result.reason, /approval/);
});

test("a cancelled run stops the loop", async (t) => {
	const root = workspace(t);
	const runId = await approvedRun(root);
	run(root, ["select", runId]);
	assert.equal(run(root, ["cancel", runId, "--reason", "superseded"]).code, 0);
	const result = observe(root);
	assert.equal(result.action, "stop");
	assert.match(result.reason, /cancelled/);
});

test("a run with every task accepted stops the loop for review", async (t) => {
	const root = workspace(t);
	const runId = await approvedRun(root);
	run(root, ["select", runId]);
	for (const [task, body] of [
		["T1", HANDOFF_T1],
		["T2", { ...HANDOFF_T1, task: "T2", changed_files: ["src/lib/second.txt"], requirements: { "R1.2": "ok" }, evidence: { "R1.2": "node tools/check.mjs" } }],
		["T3", { ...HANDOFF_T1, task: "T3", changed_files: [], requirements: { "R1.3": "ok" }, evidence: { "R1.3": "node tools/check.mjs" } }],
	]) {
		assert.equal(run(root, ["start", runId, task]).code, 0, task);
		for (const file of body.changed_files) writeFile(root, file, `${task}\n`);
		const accepted = run(root, ["accept", runId, task, handoff(root, `${task}.json`, body)]);
		assert.equal(accepted.code, 0, `${task}: ${accepted.stdout}`);
	}
	const result = observe(root);
	assert.equal(result.action, "stop");
	assert.match(result.reason, /review/);
});
