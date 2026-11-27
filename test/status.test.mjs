import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// docs/plan/status.json is what the project site shows as the project's
// status. These tests keep it honest against the plan it summarizes.

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const status = JSON.parse(read("docs/plan/status.json"));
const plan = read(status.plan);
const STATES = ["done", "in-progress", "next"];

test("status lists the plan's phases in order, with the plan's titles", () => {
	assert.equal(status.plan, "docs/plan/0001-extraction.md");
	assert.deepEqual(
		status.phases.map((phase) => phase.id),
		["P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"],
	);
	for (const { id, title } of status.phases) {
		assert.ok(plan.includes(`**${id} — ${title}.**`), `the plan has no "**${id} — ${title}.**"`);
	}
});

test("states are valid, at most one phase is in progress, and done comes first", () => {
	for (const { id, state } of status.phases) assert.ok(STATES.includes(state), `${id}: "${state}"`);
	const states = status.phases.map((phase) => phase.state);
	assert.ok(states.filter((state) => state === "in-progress").length <= 1);
	const firstNotDone = states.findIndex((state) => state !== "done");
	if (firstNotDone !== -1) {
		assert.ok(!states.slice(firstNotDone).includes("done"), "a done phase follows an unfinished one");
	}
});

test("current status: P0–P3 done, P4 in progress, the rest next", () => {
	assert.deepEqual(
		status.phases.map((phase) => `${phase.id}:${phase.state}`),
		["P0:done", "P1:done", "P2:done", "P3:done", "P4:in-progress", "P5:next", "P6:next", "P7:next", "P8:next"],
	);
});
