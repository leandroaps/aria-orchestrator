import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../lib/config.mjs";
import {
	buildExecutionGraph,
	globsOverlap,
	pathFitsTerritory,
	resolveSpec,
} from "../lib/execution-graph.mjs";
import {
	definedRequirements,
	expandRequirementTokens,
	extractHeader,
	parseDependencyGraphSection,
	parseTaskBlocks,
} from "../lib/spec-parsing.mjs";
import { SPEC, TASKS, workspace, writeFile } from "./helpers/workspace.mjs";

test("requirement ranges expand to individual ids", () => {
	assert.deepEqual([...expandRequirementTokens("covers R1.2–R1.4 and R2.1")], [
		"R1.2",
		"R1.3",
		"R1.4",
		"R2.1",
	]);
	assert.deepEqual([...expandRequirementTokens("R3.1-3.2")], ["R3.1", "R3.2"]);
});

test("header and defined requirements", () => {
	const source = "# Req\n\n**Spec ID:** 0007\n**Status:** Approved (2026-11-27)\n\n- **R1.1** a\n- **R1.2** b\n";
	assert.deepEqual(extractHeader(source), {
		id: "0007",
		statusText: "Approved (2026-11-27)",
		category: "Approved",
	});
	assert.deepEqual([...definedRequirements(source)], ["R1.1", "R1.2"]);
});

test("task blocks carry owner, requirements and task-meta", () => {
	const { tasks } = parseTaskBlocks(TASKS);
	assert.deepEqual(
		tasks.map((t) => t.id),
		["T1", "T2", "T3"],
	);
	assert.equal(tasks[1].owner, "backend");
	assert.deepEqual([...tasks[1].requirements], ["R1.2"]);
	assert.deepEqual(tasks[1].taskMeta.depends_on, ["T1"]);
	assert.deepEqual(tasks[2].taskMeta.allowed_paths, []);
});

test("manual verification section collects exceptions in both locales", () => {
	for (const heading of ["## Manual/external verification", "## Verificação manual/externa"]) {
		const { tasks, manualExceptions } = parseTaskBlocks(
			`- [x] **T1** Do (\`backend\`) → R1.1\n\n${heading}\n\n- R1.2 checked by hand\n`,
		);
		assert.equal(tasks.length, 1);
		assert.equal(tasks[0].done, true);
		assert.deepEqual([...manualExceptions], ["R1.2"]);
	}
});

test("dependency graph section: arrows and one-level tree, prose ignored", () => {
	const source = [
		"## Dependency graph",
		"",
		"```text",
		"T1 ──► T2 ──► T3",
		"T4",
		"├── T5",
		"└── T6",
		"```",
		"",
		"T9 depends on nothing; this prose mentions T8 and T7.",
	].join("\n");
	assert.deepEqual(parseDependencyGraphSection(source), {
		T2: ["T1"],
		T3: ["T2"],
		T5: ["T4"],
		T6: ["T4"],
	});
	assert.equal(parseDependencyGraphSection("no graph here"), null);
});

test("pathFitsTerritory: exact, glob, exclusion and traversal", () => {
	const territory = ["src/app/**", "!src/app/api/**", "config.json"];
	assert.ok(pathFitsTerritory("src/app/page.tsx", territory));
	assert.ok(!pathFitsTerritory("src/app/api/route.ts", territory));
	assert.ok(pathFitsTerritory("config.json", territory));
	assert.ok(!pathFitsTerritory("config.json-evil", territory));
	assert.ok(!pathFitsTerritory("src/app/../../etc/passwd", territory));
	assert.ok(!pathFitsTerritory("src/application.ts", territory));
	assert.ok(!pathFitsTerritory("src/app/page.tsx", []));
});

test("globsOverlap compares directory bases at any depth", () => {
	assert.ok(globsOverlap("src/components/**", "src/components/schedule/**"));
	assert.ok(globsOverlap("src/lib/**", "src/lib/**"));
	assert.ok(!globsOverlap("src/lib/**", "src/app/**"));
	assert.ok(!globsOverlap("!src/lib/**", "src/lib/**"));
});

test("resolveSpec needs exactly one match", (t) => {
	const root = workspace(t);
	writeFile(root, "specs/0002-other/tasks.md", "");
	const specsDir = join(root, "specs");
	assert.equal(resolveSpec(specsDir, "0001").name, SPEC);
	assert.equal(resolveSpec(specsDir, SPEC).name, SPEC);
	assert.equal(resolveSpec(specsDir, "000").name, undefined);
});

test("graph: explicit empty allowed_paths means no writes; a missing key inherits the territory", (t) => {
	const tasks = [
		"- [ ] **T1** Empty (`backend`) → R1.1",
		"",
		"  ```yaml task-meta",
		"  depends_on: []",
		"  allowed_paths: []",
		"  ```",
		"",
		"- [ ] **T2** Inherit (`frontend`) → R1.2",
		"",
		"- [ ] **T3** Narrow (`frontend`) → R1.3",
		"",
		"  ```yaml task-meta",
		"  allowed_paths: [src/app/**]",
		"  ```",
		"",
		"- [ ] **T4** Ghost (`ghost`) → R1.1",
		"",
	].join("\n");
	const root = workspace(t, { tasks });
	const graph = buildExecutionGraph(join(root, "specs"), SPEC, loadConfig(root));
	const [t1, t2, t3, t4] = graph.tasks;
	assert.deepEqual(t1.allowed_paths, []);
	assert.deepEqual(t2.allowed_paths, ["src/app/**", "src/components/**", "!src/app/api/**"]);
	// The owner's exclusion carries over to a narrowed list.
	assert.deepEqual(t3.allowed_paths, ["src/app/**", "!src/app/api/**"]);
	// No explicit graph: file order is the fallback dependency.
	assert.deepEqual(t2.depends_on, ["T1"]);
	assert.deepEqual(t2.inputs, [
		`specs/${SPEC}/requirements.md`,
		`specs/${SPEC}/design.md`,
		`specs/${SPEC}/tasks.md`,
	]);
	assert.deepEqual(t2.verification, ["node tools/check.mjs"]);
	assert.equal(t4.unknownOwner, true);
	assert.deepEqual(t4.allowed_paths, []);
	assert.deepEqual(t4.verification, ["npm test"]);
});

test("graph: an owner named like an Object prototype key is unknown", (t) => {
	const root = workspace(t, { tasks: "- [ ] **T1** Proto (`constructor`) → R1.1\n" });
	const [node] = buildExecutionGraph(join(root, "specs"), SPEC, loadConfig(root)).tasks;
	assert.equal(node.unknownOwner, true);
	assert.deepEqual(node.verification, ["npm test"]);
});
