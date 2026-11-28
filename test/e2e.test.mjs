// Plan 0001, phase P6: a full run on a fixture repository, through the three
// workflows the plugin ships, with the real question hook for the owner's
// click and the real tool guard in front of every agent's write and command.
//
//   aria-plan → the owner's click → record-approval → aria-execute →
//   the Lead commits → aria-review
//
// The workflow runtime and the agents are simulated (no model, no network):
// see helpers/workflow-runtime.mjs and helpers/simulated-team.mjs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { aria } from "./helpers/run-cli.mjs";
import { PLUGIN_ROOT, handoff, simulatedTeam } from "./helpers/simulated-team.mjs";
import { runWorkflow } from "./helpers/workflow-runtime.mjs";
import { REALITY_CHECK } from "../lib/model-policy.mjs";
import { SPEC, git, workspace, writeFile } from "./helpers/workspace.mjs";

const HOOK = join(PLUGIN_ROOT, "hooks", "question-hook.mjs");
const REQUIREMENT = { T1: "R1.1", T2: "R1.2", T3: "R1.3" };
const FILES = { T1: ["src/lib/new.txt"], T2: ["src/lib/second.txt"], T3: [] };

// The fixture repository with an `origin` whose default branch is `main`,
// working on a spec branch, as a project would.
function project(t) {
	const root = workspace(t);
	const origin = realpathSync(mkdtempSync(join(tmpdir(), "aria-origin-")));
	t.after(() => rmSync(origin, { recursive: true, force: true }));
	git(origin, ["init", "-q", "--bare", "-b", "main"]);
	git(root, ["remote", "add", "origin", origin]);
	git(root, ["push", "-q", "origin", "main"]);
	git(root, ["remote", "set-head", "origin", "main"]);
	git(root, ["checkout", "-q", "-b", "spec/0001-fixture"]);
	return root;
}

const lead = (root, argv) => aria(argv, { cwd: root, pluginRoot: PLUGIN_ROOT });

// The owner's click on the exact question, through the real hook.
async function ownerClicks(root, question, { prefilled = false } = {}) {
	const hook = (payload) =>
		spawnSync(process.execPath, [HOOK], {
			input: JSON.stringify({
				session_id: "s1",
				transcript_path: "/tmp/t.jsonl",
				cwd: root,
				permission_mode: "default",
				tool_name: "AskUserQuestion",
				tool_use_id: `toolu_${Math.random().toString(16).slice(2)}`,
				...payload,
			}),
			env: { ...process.env, CLAUDE_PROJECT_DIR: root, CLAUDE_CODE_ENTRYPOINT: "cli" },
			encoding: "utf8",
		});
	await sleep(5);
	const answered = { questions: [question], answers: { [question.question]: question.options[0].label } };
	const toolUse = `toolu_${Math.random().toString(16).slice(2)}`;
	const pre = hook({ hook_event_name: "PreToolUse", tool_use_id: toolUse, tool_input: prefilled ? answered : { questions: [question] } });
	hook({ hook_event_name: "PostToolUse", tool_use_id: toolUse, tool_input: prefilled ? answered : { questions: [question] }, tool_response: answered });
	return pre.stdout;
}

// Writes each file of its task inside the territory and returns the
// honest handoff.
function honestWorker({ owner, taskId, write }) {
	for (const file of FILES[taskId]) assert.ok(write(file, `${taskId}\n`), `${taskId} may write ${file}`);
	return handoff({ owner, taskId, files: FILES[taskId], requirement: REQUIREMENT[taskId] });
}

async function plannedRun(root, team) {
	const planned = await runWorkflow("aria-plan", { spec: SPEC }, team.agentImpl);
	assert.equal(planned.result.ok, true, JSON.stringify(planned.result));
	return planned.result.plan;
}

test("a full run: plan, the owner's click, execute, review", async (t) => {
	const root = project(t);
	const team = simulatedTeam(root, { worker: honestWorker });

	// Plan: reality check, graph, impact. The tasks' allowed_paths are globs,
	// which the classifier cannot expand, so the plan counts as high impact
	// (closed when unsure) and gets the security pre-review.
	const planned = await runWorkflow("aria-plan", { spec: SPEC }, team.agentImpl);
	assert.equal(planned.result.ok, true, JSON.stringify(planned.result));
	assert.deepEqual(planned.phases, ["Reality check", "Graph", "Security"]);
	assert.equal(planned.result.high_impact, true);
	assert.deepEqual(planned.result.impact_problems, ["glob in allowed_paths: src/lib/**"]);
	assert.deepEqual(planned.result.security, { findings: [], blocks_dispatch: false, blocks_closing: false });
	const { run_id: runId, approval_prefix: prefix, approval_question: question } = planned.result.plan;
	assert.match(prefix, /^[0-9a-f]{12}$/);
	assert.match(planned.result.next, new RegExp(prefix));

	// Before the click nothing is dispatched.
	const early = await runWorkflow("aria-execute", { run: runId }, team.agentImpl);
	assert.equal(early.result.ok, false);
	assert.match(early.result.blocked, /not approved/);
	assert.equal(early.calls.filter((call) => call.label.startsWith("work:")).length, 0);

	// The owner clicks; the Lead records the approval.
	assert.equal(await ownerClicks(root, question), "");
	const recorded = lead(root, ["run", "record-approval", runId, "--json"]);
	assert.equal(recorded.code, 0, recorded.stdout);

	// Execute: T1 and T3 in the first round, T2 after T1.
	const executed = await runWorkflow("aria-execute", { run: runId }, team.agentImpl);
	assert.equal(executed.result.ok, true, JSON.stringify(executed.result, null, 2));
	assert.deepEqual(
		executed.result.outcomes.map((outcome) => [outcome.round, outcome.taskId, outcome.accepted?.ok]),
		[
			[1, "T1", true],
			[1, "T3", true],
			[2, "T2", true],
		],
	);
	assert.deepEqual(executed.logs, ["T1: accepted", "T3: accepted", "T2: accepted"]);
	assert.match(executed.result.next, /aria-review/);
	assert.deepEqual(team.guardLog.filter((entry) => entry.denied), []);
	// Every handoff the controller wrote is on disk, as the workflow said.
	for (const task of ["T1", "T2", "T3"]) {
		assert.equal(JSON.parse(readFileSync(join(root, ".aria", "handoffs", `${runId}-${task}.json`), "utf8")).task, task);
	}

	// The Lead commits the accepted change; the review gates pass.
	git(root, ["add", "src/lib"]);
	git(root, ["commit", "-q", "-m", "spec 0001"]);
	const reviewed = await runWorkflow("aria-review", { run: runId, checks: ["node tools/check.mjs"] }, team.agentImpl);
	assert.equal(reviewed.result.ok, true, JSON.stringify(reviewed.result, null, 2));
	assert.deepEqual(
		reviewed.result.gates.map((gate) => [gate.command, gate.exit_code]),
		[
			["aria gate --json", 0],
			[`aria validate spec ${SPEC} --json`, 0],
			[`aria validate graph ${SPEC} --json`, 0],
			["node tools/check.mjs", 0],
		],
	);
	assert.deepEqual(reviewed.result.scope.files, ["src/lib/new.txt", "src/lib/second.txt"]);
	// The review closes the run through the real controller.
	assert.equal(reviewed.result.closed.state, "ready_for_review");
	assert.equal(lead(root, ["run", "status", runId, "--json"]).json().state, "ready_for_review");

	// The loop stops: the run waits for review.
	assert.equal(lead(root, ["run", "select", runId]).code, 0);
	const observed = lead(root, ["run", "observe", "--checks", "none", "--json"]).json();
	assert.equal(observed.action, "stop");
	assert.match(observed.reason, /ready for review/);
});

test("without the owner's click nothing runs: a prefilled answer and a typed approval approve nothing", async (t) => {
	const root = project(t);
	const team = simulatedTeam(root, { worker: honestWorker });
	const { run_id: runId, approval_question: question, approval_prefix: prefix } = await plannedRun(root, team);

	// The model fills in the answer itself: the hook denies the question.
	const denied = JSON.parse(await ownerClicks(root, question, { prefilled: true }));
	assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
	assert.equal(lead(root, ["run", "record-approval", runId, "--json"]).code, 1);

	// A typed "approve <prefix>" is only logged.
	const prompt = spawnSync(process.execPath, [join(PLUGIN_ROOT, "hooks", "prompt-hook.mjs")], {
		input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: root, prompt: `approve ${prefix}` }),
		env: { ...process.env, CLAUDE_PROJECT_DIR: root },
		encoding: "utf8",
	});
	assert.equal(prompt.status, 0, prompt.stderr);
	const refused = lead(root, ["run", "record-approval", runId, "--json"]);
	assert.equal(refused.code, 1);
	assert.match(refused.json().error, /source_not_user|prefilled_answers|pre_check_missing/);

	// Nothing is dispatched, by the workflow or by hand.
	const executed = await runWorkflow("aria-execute", { run: runId }, team.agentImpl);
	assert.match(executed.result.blocked, /not approved/);
	assert.equal(lead(root, ["run", "start", runId, "T1", "--json"]).code, 1);
	assert.equal(executed.calls.filter((call) => call.label.startsWith("work:")).length, 0);
});

test("a plan changed after approval voids it: execute stops until the owner approves again", async (t) => {
	const root = project(t);
	const team = simulatedTeam(root, { worker: honestWorker });
	const { run_id: runId, approval_question: question } = await plannedRun(root, team);
	await ownerClicks(root, question);
	assert.equal(lead(root, ["run", "record-approval", runId, "--json"]).code, 0);

	const tasks = join(root, "specs", SPEC, "tasks.md");
	writeFileSync(tasks, readFileSync(tasks, "utf8").replace("Body of task T1.", "Body of task T1, widened."));
	const executed = await runWorkflow("aria-execute", { run: runId }, team.agentImpl);
	assert.equal(executed.result.ok, false);
	assert.match(executed.result.blocked, /not approved/);
	assert.equal(executed.calls.filter((call) => call.label.startsWith("work:")).length, 0);
});

test("out of territory: the guard denies the write, and a write around it is refused and routed until the run blocks", async (t) => {
	const root = project(t);
	let attempts = 0;
	const worker = (context) => {
		if (context.taskId !== "T2") return honestWorker(context);
		attempts += 1;
		// Through the harness, the guard denies a path outside the territory
		// and inside the sensitive set.
		assert.equal(context.write("src/app/page.tsx", "x\n"), false);
		assert.equal(context.write("aria.config.json", "{}\n"), false);
		assert.equal(context.bash("echo x > src/app/page.tsx").denied, true);
		// Around the guard (a tool the hook does not see): the change is real,
		// and the handoff leaves it out.
		writeFile(root, "src/app/page.tsx", `attempt ${attempts}\n`);
		context.write("src/lib/second.txt", `T2 attempt ${attempts}\n`);
		return handoff({ owner: context.owner, taskId: "T2", files: ["src/lib/second.txt"], requirement: "R1.2" });
	};
	const team = simulatedTeam(root, { worker });
	const { run_id: runId, approval_question: question } = await plannedRun(root, team);
	await ownerClicks(root, question);
	assert.equal(lead(root, ["run", "record-approval", runId, "--json"]).code, 0);

	const executed = await runWorkflow("aria-execute", { run: runId }, team.agentImpl);
	assert.equal(executed.result.ok, false);
	assert.equal(executed.result.state, "blocked");
	assert.match(executed.result.next, /escalate to the owner/);
	assert.equal(attempts, 3);
	const refusals = executed.result.outcomes.filter((outcome) => outcome.taskId === "T2");
	assert.equal(refusals.length, 3);
	for (const outcome of refusals) {
		assert.equal(outcome.accepted.ok, false);
		assert.ok(outcome.accepted.findings.some((finding) => /src\/app\/page\.tsx/.test(finding)), JSON.stringify(outcome.accepted.findings));
	}
	assert.equal(refusals.at(-1).accepted.routing.decision, "blocked");

	const denials = team.guardLog.filter((entry) => entry.denied);
	assert.deepEqual(
		denials.map((entry) => [entry.agentType, entry.tool]),
		Array.from({ length: 3 }, () => [
			["backend", "Write"],
			["backend", "Write"],
			["backend", "Bash"],
		]).flat(),
	);
	assert.equal(lead(root, ["status", runId, "--json"]).json().state, "blocked");
});

test("a token limit stops dispatching between rounds, leaving the run consistent", async (t) => {
	const root = project(t);
	const team = simulatedTeam(root, { worker: honestWorker });
	const { run_id: runId, approval_question: question } = await plannedRun(root, team);
	await ownerClicks(root, question);
	assert.equal(lead(root, ["run", "record-approval", runId, "--json"]).code, 0);

	// Round 1 (status, then start, work and accept for T1 and T3) spends
	// 7 agents; the limit is reached before round 2 would dispatch T2.
	const executed = await runWorkflow("aria-execute", { run: runId, tokenLimit: 5000 }, team.agentImpl, { tokensPerAgent: 1000 });
	assert.equal(executed.result.ok, false);
	assert.equal(executed.result.stopped_by_token_limit, true);
	assert.equal(executed.result.tokens, 8000);
	assert.match(executed.result.next, /token limit/);
	assert.deepEqual(executed.result.outcomes.map((outcome) => [outcome.taskId, outcome.accepted?.ok]), [["T1", true], ["T3", true]]);
	assert.ok(executed.logs.some((line) => /token limit/.test(line)));
	// Nothing is left running: the next run of the workflow picks T2 up.
	const status = lead(root, ["status", runId, "--json"]).json();
	assert.deepEqual(status.dispatchable, ["T2"]);
	const resumed = await runWorkflow("aria-execute", { run: runId }, team.agentImpl);
	assert.equal(resumed.result.ok, true, JSON.stringify(resumed.result));
});

test("every workflow reports what it spent, and the reality check names its model", async (t) => {
	const root = project(t);
	const team = simulatedTeam(root, { worker: honestWorker });
	const planned = await runWorkflow("aria-plan", { spec: SPEC }, team.agentImpl, { tokensPerAgent: 10 });
	assert.equal(planned.result.tokens, planned.calls.length * 10);
	const reality = planned.calls.find((call) => call.label.startsWith("reality:"));
	assert.deepEqual([reality.agentType, reality.model, reality.effort], ["Explore", REALITY_CHECK.model, REALITY_CHECK.effort]);
	const early = await runWorkflow("aria-execute", { run: planned.result.plan.run_id }, team.agentImpl, { tokensPerAgent: 10 });
	assert.equal(early.result.tokens, early.calls.length * 10);
	const reviewed = await runWorkflow("aria-review", { run: planned.result.plan.run_id }, team.agentImpl, { tokensPerAgent: 10 });
	assert.equal(reviewed.result.tokens, reviewed.calls.length * 10);
});
