// `aria status [<run-id>]`: the run summary, rendered by the terminal layer.

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HANDOFF_T1, aria, approvedRun, create, handoff, run } from "./helpers/run-cli.mjs";
import { SPEC, workspace, writeFile } from "./helpers/workspace.mjs";

const ESC = /\x1b\[/;
const TTY = { env: {}, isTTY: true, platform: "darwin" };

function status(root, argv = [], options = {}) {
	return aria(["status", ...argv], { cwd: root, ...options });
}

function statusJson(root, argv = []) {
	const result = status(root, [...argv, "--json"]);
	assert.equal(result.code, 0, result.stdout + result.stderr);
	return result.json();
}

// --- The summary --------------------------------------------------------------

test("a new run: approval needed, next step is presenting the plan", (t) => {
	const root = workspace(t);
	const runId = create(root);
	const summary = statusJson(root, [runId]);
	assert.equal(summary.run_id, runId);
	assert.equal(summary.spec, SPEC);
	assert.equal(summary.state, "planned");
	assert.equal(summary.approval.valid, false);
	assert.match(summary.approval.prefix, /^[0-9a-f]{12}$/);
	assert.deepEqual(summary.dispatchable, []);
	assert.deepEqual(
		summary.tasks.map((task) => [task.id, task.owner, task.state, task.blocked]),
		[
			["T1", "backend", "pending", false],
			["T2", "backend", "pending", true],
			["T3", "backend", "pending", false],
		],
	);
	assert.deepEqual(summary.tasks[1].reasons, ["T1 not completed"]);
	assert.equal(summary.last_failure, null);
	assert.match(summary.next, new RegExp(`^aria run plan ${runId}`));
});

test("an approved run: the next step starts the first ready task", async (t) => {
	const root = workspace(t);
	const runId = await approvedRun(root);
	const summary = statusJson(root, [runId]);
	assert.equal(summary.approval.valid, true);
	assert.deepEqual(summary.dispatchable, ["T1", "T3"]);
	assert.equal(summary.next, `aria run start ${runId} T1`);
});

test("a running task: the next step accepts it, or records the failure", async (t) => {
	const root = workspace(t);
	const runId = await approvedRun(root);
	run(root, ["start", runId, "T1"]);
	const summary = statusJson(root, [runId]);
	assert.equal(summary.tasks[0].state, "running");
	assert.equal(summary.next, `aria run accept ${runId} T1 <handoff.json> (or aria run fail)`);
});

test("a blocked run: the last failure and a human decision", async (t) => {
	const root = workspace(t);
	const runId = await approvedRun(root);
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		run(root, ["start", runId, "T3"]);
		writeFile(root, "src/lib/attempt.txt", `${attempt}\n`);
		run(root, ["fail", runId, "T3", "--category", "other", "--repro", "flaky", "--requirement", "R1.3"]);
	}
	const summary = statusJson(root, [runId]);
	assert.equal(summary.state, "blocked");
	assert.deepEqual(summary.last_failure, { task: "T3", category: "other", attempts: 3, requirement: "R1.3" });
	assert.equal(summary.next, "human decision: the run is blocked");
	assert.deepEqual(summary.dispatchable, []);
});

test("every task accepted: the next step is the final review", async (t) => {
	const root = workspace(t);
	const runId = await approvedRun(root);
	run(root, ["start", runId, "T1"]);
	writeFile(root, "src/lib/new.txt", "new\n");
	assert.equal(run(root, ["accept", runId, "T1", handoff(root, "t1.json", HANDOFF_T1)]).code, 0);
	for (const [id, file] of [["T2", "src/lib/two.txt"], ["T3", null]]) {
		run(root, ["start", runId, id]);
		if (file) writeFile(root, file, `${id}\n`);
		const body = {
			task: id,
			agent: "backend",
			status: "completed",
			changed_files: file ? [file] : [],
			requirements: {},
			evidence: {},
		};
		const accepted = run(root, ["accept", runId, id, handoff(root, `${id}.json`, body)]);
		assert.equal(accepted.code, 0, accepted.stdout);
	}
	assert.equal(statusJson(root, [runId]).next, "all tasks accepted: run the final review");
});

test("without a run id: the most recent run", (t) => {
	const root = workspace(t);
	create(root);
	const latest = create(root);
	assert.equal(statusJson(root).run_id, latest);
});

test("without a run id and without runs: refused with a hint", (t) => {
	const root = workspace(t);
	const result = status(root);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /no runs yet.*aria run create <spec>/);
});

// --- Rendering ------------------------------------------------------------------

test("plain, not a TTY: no escape code, the run, its state and the next step", async (t) => {
	const root = workspace(t);
	const runId = create(root);
	const { code, stdout } = status(root, [runId]);
	assert.equal(code, 0);
	assert.doesNotMatch(stdout, ESC);
	const lines = stdout.split("\n");
	assert.equal(lines[0], `ARIA · run ${runId} · ${SPEC}`);
	assert.equal(lines[1], "○ planned");
	assert.match(stdout, /^◆ approval needed · prefix [0-9a-f]{12}$/m);
	assert.match(stdout, /^ {2}■ T2 {2}backend {2}blocked: T1 not completed$/m);
	assert.match(stdout, /^0 of 3 tasks accepted\.$/m);
	assert.equal(lines.at(-1), `Next: aria run plan ${runId}, then ask the owner to approve (only their click approves)`);
});

test("colour on a TTY, and never in --json even when forced", (t) => {
	const root = workspace(t);
	const runId = create(root);
	assert.match(status(root, [runId], { terminal: TTY }).stdout, ESC);
	const forced = { env: { FORCE_COLOR: "1" }, isTTY: true, platform: "darwin" };
	const json = status(root, [runId, "--json"], { terminal: forced }).stdout;
	assert.doesNotMatch(json, ESC);
	JSON.parse(json);
	assert.doesNotMatch(status(root, [runId], { terminal: { ...TTY, env: { NO_COLOR: "1" } } }).stdout, ESC);
});

test("ASCII symbols on the legacy Windows console", (t) => {
	const root = workspace(t);
	const runId = create(root);
	const { stdout } = status(root, [runId], { terminal: { env: {}, isTTY: false, platform: "win32" } });
	assert.match(stdout, /^\[\?\] approval needed/m);
	assert.match(stdout, /^ {2}\[#\] T2/m);
	assert.doesNotMatch(stdout, /[◆■○✓]/);
});

test("minimal hides accepted tasks; --verbose lists them all; --debug adds internals", async (t) => {
	const root = workspace(t);
	const runId = await approvedRun(root);
	run(root, ["start", runId, "T1"]);
	writeFile(root, "src/lib/new.txt", "new\n");
	run(root, ["accept", runId, "T1", handoff(root, "t1.json", HANDOFF_T1)]);

	const minimal = status(root, [runId]).stdout;
	assert.doesNotMatch(minimal, / T1 /);
	assert.match(minimal, /^1 of 3 tasks accepted\.$/m);

	const standard = status(root, [runId, "--verbose"]).stdout;
	assert.match(standard, /^ {2}✓ T1 {2}backend {2}completed$/m);
	assert.doesNotMatch(standard, /plan digest/);

	const debug = status(root, [runId, "--debug"]).stdout;
	assert.match(debug, /^ {2}✓ T1/m);
	assert.match(debug, /^plan digest [0-9a-f]{64}$/m);
	assert.match(debug, new RegExp(`^run directory \\.aria/runs/${runId}$`, "m"));
	assert.match(debug, /^terminal: colour off, Unicode on$/m);
});

test("a voided approval is shown at every verbosity", async (t) => {
	const root = workspace(t);
	const runId = await approvedRun(root);
	writeFile(root, ".claude/settings.json", '{ "hooks": { "changed": true } }\n');
	const { stdout } = status(root, [runId]);
	assert.match(stdout, /^! approval not valid: \.claude\/settings\.json changed after the approval$/m);
	assert.match(stdout, /^Next: aria run plan /m);
});

test("status takes no run command options", (t) => {
	const root = workspace(t);
	assert.equal(status(root, ["--reason", "x"]).code, 2);
	assert.equal(status(root, ["not-a-run"]).code, 2);
});

// Plan 0001 P7, round 2: aria-execute dispatched the owner `test` as agent
// type `test`, which does not exist; the plugin's agent is
// `aria-orchestrator:test`. The status gives each task the agent type that
// does exist: the project's own agent first, then the plugin's.
test("each task carries the agent type that runs it", (t) => {
	const root = workspace(t);
	const plugin = realpathSync(mkdtempSync(join(tmpdir(), "aria-plugin-agents-")));
	t.after(() => rmSync(plugin, { recursive: true, force: true }));
	writeFile(plugin, "hooks/question-hook.mjs", "// test hook\n");
	writeFile(plugin, "agents/backend.md", "---\nname: backend\n---\n");
	writeFile(plugin, "agents/security.md", "---\nname: security\n---\n");
	writeFile(root, ".claude/agents/backend.md", "---\nname: backend\n---\n");
	const runId = create(root);
	const summary = aria(["status", runId, "--json"], { cwd: root, pluginRoot: plugin }).json();
	assert.deepEqual(summary.tasks.map((task) => [task.id, task.owner, task.agent_type]), [
		["T1", "backend", "backend"],
		["T2", "backend", "backend"],
		["T3", "backend", "backend"],
	]);
	rmSync(join(root, ".claude", "agents", "backend.md"));
	const fromPlugin = aria(["status", runId, "--json"], { cwd: root, pluginRoot: plugin }).json();
	assert.equal(fromPlugin.tasks[0].agent_type, "aria-orchestrator:backend");
	const neither = aria(["status", runId, "--json"], { cwd: root }).json();
	assert.equal(neither.tasks[0].agent_type, "backend");
});
