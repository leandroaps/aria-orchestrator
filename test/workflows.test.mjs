// `aria validate workflows`: the static checks on workflow scripts, and the
// workflows the plugin ships.

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REQUIRED_WORKFLOWS, workflowProblems } from "../lib/workflow-check.mjs";
import { aria } from "./helpers/run-cli.mjs";
import { workspace, writeFile } from "./helpers/workspace.mjs";

const PLUGIN_ROOT = join(import.meta.dirname, "..");

const GOOD = `export const meta = {
	name: "demo",
	description: "A demo workflow",
	phases: [{ title: "Read" }, { title: "Check" }],
};

phase("Read");
const found = await agent("Read the spec", { schema: { type: "object" }, model: "sonnet", effort: "low" });
phase("Check");
return { ok: found !== null, found };
`;

test("a well-formed workflow has no problem", () => {
	assert.deepEqual(workflowProblems("demo", GOOD), []);
});

test("meta must open the file and be a plain literal", () => {
	assert.match(workflowProblems("demo", `const x = 1;\n${GOOD}`).join(), /must open the file/);
	assert.match(workflowProblems("demo", "phase('x');\n").join(), /no `export const meta/);
	const computed = GOOD.replace('"A demo workflow"', "describe()");
	assert.match(workflowProblems("demo", computed).join(), /not a plain literal/);
	const spread = GOOD.replace('name: "demo",', 'name: "demo", ...extra,');
	assert.match(workflowProblems("demo", spread).join(), /not a plain literal/);
	const template = GOOD.replace('"A demo workflow"', "`A ${kind}`");
	assert.match(workflowProblems("demo", template).join(), /not a plain literal/);
});

test("meta.name matches the file and description is present", () => {
	assert.match(workflowProblems("other", GOOD).join(), /meta.name "demo" differs from the file "other"/);
	const noDescription = GOOD.replace('description: "A demo workflow",', "");
	assert.match(workflowProblems("demo", noDescription).join(), /meta.description is missing/);
});

test("each phase listed in meta is opened with the same title", () => {
	const renamed = GOOD.replace('phase("Check");', 'phase("Verify");');
	assert.match(workflowProblems("demo", renamed).join(), /phase "Check" is listed in meta but never opened/);
});

test("syntax errors are reported", () => {
	assert.match(workflowProblems("demo", GOOD.replace("return {", "return {{")).join(), /syntax/);
});

test("what the runtime refuses, or what hides a failure, is reported", () => {
	const cases = [
		['import { x } from "y";', /module import/],
		['const m = await import("y");', /module import/],
		['const fs = require("fs");', /require\(\)/],
		["const home = process.env.HOME;", /process/],
		['const out = execSync("ls");', /filesystem or shell/],
		["const now = Date.now();", /clock or randomness/],
		["const roll = Math.random();", /clock or randomness/],
		["const today = new Date();", /clock or randomness/],
		["const kept = [1, null].filter(Boolean);", /filter\(Boolean\) hides a null result/],
	];
	for (const [line, pattern] of cases) {
		const source = GOOD.replace('phase("Read");', `${line}\nphase("Read");`);
		assert.match(workflowProblems("demo", source).join(), pattern, line);
	}
	// A date built from a value the caller passed is deterministic.
	const fromArgs = GOOD.replace('phase("Read");', "const at = new Date(args.at);\nphase(\"Read\");");
	assert.deepEqual(workflowProblems("demo", fromArgs), []);
});

test("the shipped workflows pass and are the required set", () => {
	const result = aria(["validate", "workflows", "--json"], { cwd: PLUGIN_ROOT, pluginRoot: PLUGIN_ROOT });
	assert.equal(result.code, 0, result.stdout + result.stderr);
	const report = result.json();
	assert.equal(report.ok, true);
	for (const name of REQUIRED_WORKFLOWS) assert.deepEqual(report.workflows[`workflows/${name}.js`], [], name);
});

test("a consumer repository: the plugin's workflows and its own are checked", (t) => {
	const root = workspace(t);
	writeFile(root, ".claude/workflows/mine.js", GOOD.replace('name: "demo"', 'name: "other"'));
	const result = aria(["validate", "workflows", "--json"], { cwd: root, pluginRoot: PLUGIN_ROOT });
	assert.equal(result.code, 1);
	const report = result.json();
	assert.deepEqual(report.workflows[".claude/workflows/mine.js"], ['meta.name "other" differs from the file "mine"']);
	assert.deepEqual(report.workflows["workflows/aria-plan.js"], []);
});

test("a plugin missing a required workflow fails", (t) => {
	const plugin = realpathSync(mkdtempSync(join(tmpdir(), "aria-plugin-")));
	t.after(() => rmSync(plugin, { recursive: true, force: true }));
	writeFile(plugin, "workflows/aria-plan.js", GOOD.replace('name: "demo"', 'name: "aria-plan"'));
	const root = workspace(t);
	const result = aria(["validate", "workflows"], { cwd: root, pluginRoot: plugin });
	assert.equal(result.code, 1);
	assert.match(result.stdout, /workflows\/aria-execute\.js: file missing/);
	assert.match(result.stdout, /workflows\/aria-review\.js: file missing/);
});

// The model policy reaches the workflows: no agent() call falls back to the
// session's model.
test("every agent() names its model, directly or through a plugin agent", () => {
	const call = (options) => GOOD.replace('{ schema: { type: "object" }, model: "sonnet", effort: "low" }', options);
	assert.deepEqual(workflowProblems("demo", call('{ agentType: CONTROLLER, schema: {} }')), []);
	assert.deepEqual(workflowProblems("demo", call('{ agentType: "aria-orchestrator:security" }')), []);
	assert.deepEqual(workflowProblems("demo", call('{ agentType: "Explore", model: "sonnet", effort: "medium" }')), []);
	assert.match(workflowProblems("demo", call("{ schema: {} }")).join(), /agent\(\) at line 8 names no model/);
	assert.match(workflowProblems("demo", call('{ agentType: "Explore" }')).join(), /agent\(\) at line 8 uses the built-in "Explore" without a model/);
	assert.match(workflowProblems("demo", GOOD.replace('agent("Read the spec", { schema: { type: "object" }, model: "sonnet", effort: "low" })', 'agent("Read the spec")')).join(), /agent\(\) at line 8 names no model/);
});
