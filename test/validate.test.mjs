import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../lib/config.mjs";
import { buildExecutionGraph } from "../lib/execution-graph.mjs";
import { createRun, runPath } from "../lib/run-state.mjs";
import {
	graphFindings,
	handoffOwnershipFindings,
	handoffShapeFindings,
	listRunIds,
	runFindings,
	specFindings,
} from "../lib/validate.mjs";
import { CONFIG, PARALLEL_TASKS, REQUIREMENTS, SPEC, TASKS, git, workspace, writeFile } from "./helpers/workspace.mjs";

const header = (status = "Approved", id = "0001") => `**Spec ID:** ${id}\n**Status:** ${status}\n`;

function spec(root, files) {
	for (const [name, content] of Object.entries(files)) writeFile(root, `specs/${SPEC}/${name}`, content);
	return specFindings(join(root, "specs"), SPEC);
}

// --- Spec ------------------------------------------------------------------------

test("spec: the fixture is consistent", (t) => {
	const root = workspace(t);
	assert.deepEqual(specFindings(join(root, "specs"), SPEC), { findings: [], info: [] });
});

test("spec: a draft with only requirements.md is info, not a finding", (t) => {
	const root = workspace(t);
	git(root, ["rm", "-q", `specs/${SPEC}/tasks.md`]);
	const { findings, info } = specFindings(join(root, "specs"), SPEC);
	assert.deepEqual(findings, []);
	assert.match(info[0], /only requirements\.md exists/);
});

test("spec: missing requirements.md, Spec ID or Status category", (t) => {
	const root = workspace(t);
	git(root, ["rm", "-q", `specs/${SPEC}/requirements.md`]);
	assert.match(specFindings(join(root, "specs"), SPEC).findings[0], /requirements\.md is missing/);
	const { findings } = spec(root, { "requirements.md": "# R\n\n**Status:** Someday\n\n- **R1.1** x\n" });
	assert.ok(findings.some((f) => /no "Spec ID:"/.test(f)));
	assert.ok(findings.some((f) => /Status "Someday" does not start with Draft/.test(f)));
});

test("spec: ids and status must agree across the three files", (t) => {
	const root = workspace(t);
	const { findings } = spec(root, { "design.md": `# Design\n\n${header("Draft", "0002")}` });
	assert.ok(findings.includes(`${SPEC}/design.md: Spec ID "0002" differs from requirements.md ("0001")`));
	assert.ok(findings.includes(`${SPEC}/design.md: Status "Draft" differs from requirements.md ("Approved")`));
});

test("spec: requirement coverage in both directions", (t) => {
	const root = workspace(t);
	const tasks = `# Tasks\n\n${header()}
- [ ] **T1** Cites nothing (\`backend\`)
- [ ] **T2** Cites a ghost (\`backend\`) → R9.9
- [ ] **T3** Covers one (\`backend\`) → R1.1
`;
	const { findings } = spec(root, { "tasks.md": tasks });
	assert.deepEqual(findings, [
		`${SPEC}/tasks.md: T1 cites no requirement`,
		`${SPEC}/tasks.md: T2 cites R9.9, which requirements.md does not define`,
		`${SPEC}: R1.2 has no task and no manual/external verification entry`,
		`${SPEC}: R1.3 has no task and no manual/external verification entry`,
	]);
	const withManual = `${tasks}\n## Manual/external verification\n\n- R1.2–R1.3: checked by hand.\n`;
	assert.equal(spec(root, { "tasks.md": withManual }).findings.length, 2);
});

test("spec: a Superseded spec skips coverage", (t) => {
	const root = workspace(t);
	const { findings, info } = spec(root, {
		"requirements.md": REQUIREMENTS.replace("Approved", "Superseded"),
		"tasks.md": `# Tasks\n\n${header("Superseded")}\n- [ ] **T1** Nothing (\`backend\`)\n`,
	});
	assert.deepEqual(findings, []);
	assert.match(info[0], /Superseded/);
});

// --- Graph -----------------------------------------------------------------------

function graph(root, tasks) {
	writeFile(root, `specs/${SPEC}/tasks.md`, tasks);
	const config = loadConfig(root);
	return graphFindings(buildExecutionGraph(join(root, "specs"), SPEC, config), config);
}

const meta = (id, owner, extra) => `- [ ] **${id}** Task (\`${owner}\`) → R1.1

  \`\`\`yaml task-meta
  id: ${id}
${extra
	.split("\n")
	.map((line) => `  ${line}`)
	.join("\n")}
  \`\`\`
`;

test("graph: the run fixture is valid; the parallel one races only where it means to", (t) => {
	const root = workspace(t);
	assert.deepEqual(graph(root, TASKS), []);
	// T10 (performance) writes src/lib/sub/**, inside T1/T2's src/lib/**.
	assert.deepEqual(
		graph(root, PARALLEL_TASKS).map((finding) => finding.split(" do not")[0]),
		["T1 and T10", "T2 and T10"],
	);
});

test("graph: unknown owner, missing dependency and cycle", (t) => {
	const root = workspace(t);
	const findings = graph(
		root,
		`# Tasks\n\n${header()}
${meta("T1", "ghost", "depends_on: [T9]\nallowed_paths: []")}
${meta("T2", "backend", "depends_on: [T3]\nallowed_paths: []")}
${meta("T3", "backend", "depends_on: [T2]\nallowed_paths: []")}`,
	);
	assert.deepEqual(findings, [
		'T1: owner "ghost" is not an agent in aria.config.json',
		'T1: depends on "T9", which is not in the graph',
		"dependency cycle: T2 → T3 → T2",
	]);
});

test("graph: allowed paths outside the owner's territory", (t) => {
	const root = workspace(t);
	const findings = graph(root, `# Tasks\n\n${header()}\n${meta("T1", "backend", "depends_on: []\nallowed_paths:\n  - src/app/**")}`);
	assert.deepEqual(findings, ['T1: allowed path "src/app/**" is outside the territory of "backend"']);
});

test("graph: independent tasks of different owners must not write the same paths", (t) => {
	const root = workspace(t);
	// performance owns src/lib/sub/**, inside backend's src/lib/**.
	const parallel = (dependsOn) => `# Tasks\n\n${header()}
${meta("T1", "backend", "depends_on: []\nallowed_paths:\n  - src/lib/**")}
${meta("T2", "performance", `depends_on: ${dependsOn}\nallowed_paths:\n  - src/lib/sub/**`)}`;
	assert.deepEqual(graph(root, parallel("[]")), [
		"T1 and T2 do not depend on each other but write overlapping paths; serialize them or add a predecessor that freezes the contract",
	]);
	assert.deepEqual(graph(root, parallel("[T1]")), []);
});

// --- Handoff ---------------------------------------------------------------------

const HANDOFF = {
	agent: "backend",
	task: "T1",
	status: "completed",
	requirements: { "R1.1": "ok" },
	changed_files: ["src/lib/new.ts"],
	verification: [],
	findings: [],
	blocked_by: [],
	next: [],
};

test("handoff: shape", () => {
	assert.deepEqual(handoffShapeFindings(HANDOFF), []);
	assert.deepEqual(handoffShapeFindings([]), ["the handoff must be a JSON object"]);
	const { next, ...withoutNext } = HANDOFF;
	assert.deepEqual(handoffShapeFindings({ ...withoutNext, status: "done", changed_files: "x" }), [
		'required field "next" is missing',
		'status "done" is not one of completed, failed, blocked',
		'"changed_files" must be an array, even when empty',
	]);
	assert.deepEqual(handoffShapeFindings({ ...HANDOFF, status: "failed" }), [
		'status "failed" needs at least one finding with an observable reproduction',
	]);
	assert.deepEqual(handoffShapeFindings({ ...HANDOFF, status: "failed", findings: [{ requirement: "R1.1" }] }), [
		'findings[0] has no "owner"',
		'findings[0] has no "expected"',
		'findings[0] has no "observed"',
		'findings[0] has no "reproduction"',
	]);
});

test("handoff: the owner comes from the graph and files stay in the task's paths", (t) => {
	const root = workspace(t);
	const tree = buildExecutionGraph(join(root, "specs"), SPEC, loadConfig(root));
	assert.deepEqual(handoffOwnershipFindings(HANDOFF, tree), []);
	assert.deepEqual(
		handoffOwnershipFindings({ ...HANDOFF, agent: "frontend", changed_files: ["src/app/page.tsx"] }, tree),
		[
			'handoff.agent ("frontend") differs from the task\'s owner in the graph ("backend")',
			'changed file "src/app/page.tsx" is outside the allowed_paths of T1 (src/lib/**)',
		],
	);
	assert.deepEqual(handoffOwnershipFindings({ ...HANDOFF, task: "T3", changed_files: ["src/lib/a"] }, tree), [
		'changed file "src/lib/a" is outside the allowed_paths of T3 (none)',
	]);
	assert.deepEqual(handoffOwnershipFindings({ ...HANDOFF, task: "T9" }, tree), [`task "T9" is not in the graph of ${SPEC}`]);
});

// --- Run -------------------------------------------------------------------------

test("run: a new run is valid; damage is reported, never repaired", (t) => {
	const root = workspace(t);
	assert.deepEqual(listRunIds(root), []);
	const { run_id: runId } = createRun(root, {
		spec: SPEC,
		worktree: root,
		branch: "main",
		baseCommit: git(root, ["rev-parse", "HEAD"]),
	});
	assert.deepEqual(listRunIds(root), [runId]);
	assert.deepEqual(runFindings(root, runId), []);

	assert.deepEqual(runFindings(root, "not-a-run"), ['"not-a-run" is not a run id']);
	assert.deepEqual(runFindings(root, "20260101T000000Z-abcdef"), ["manifest.json is missing"]);

	writeFileSync(join(runPath(root, runId), "events.jsonl"), "{broken\n");
	assert.deepEqual(runFindings(root, runId), [
		"1 invalid line(s) in events.jsonl",
		'events.jsonl has no "created" event',
	]);
	writeFileSync(join(runPath(root, runId), "manifest.json"), "{");
	assert.deepEqual(runFindings(root, runId), ["manifest.json is not valid JSON"]);
});

test("the fixture config still has the agents these tests rely on", () => {
	assert.ok(CONFIG.agents.backend && CONFIG.agents.performance && CONFIG.agents.security);
});
