// Single steps of the shipped workflows, with stub agents and no repository.
// Plan 0001 P7, round 2 found each case here in a real run.

import assert from "node:assert/strict";
import { test } from "node:test";
import { runWorkflow } from "./helpers/workflow-runtime.mjs";

const RUN = "20261127T203321Z-4389bb";

function statusWith(tasks, dispatchable) {
	return { state: "approved", approval_valid: true, approval_reasons: [], dispatchable, tasks };
}

// A run with one task: status, then start, work and accept; the second
// status reports it completed.
function executeTeam({ task, work }) {
	let statusCalls = 0;
	const calls = [];
	const agentImpl = async (prompt, options) => {
		calls.push({ label: options.label, agentType: options.agentType, prompt });
		const [kind] = options.label.split(":");
		if (kind === "status") {
			statusCalls += 1;
			return statusCalls === 1
				? statusWith([{ ...task, state: "pending" }], [task.id])
				: { ...statusWith([{ ...task, state: "completed" }], []), state: "running" };
		}
		if (kind === "start") return { ok: true };
		if (kind === "work") return work(options);
		if (kind === "accept") return { ok: true, findings: [] };
		if (kind === "fail") return { ok: true, routing: { decision: "route_to_owner", owner: task.owner } };
		throw new Error(`unexpected agent ${options.label}`);
	};
	return { agentImpl, calls };
}

const handoff = { agent: "test", task: "T1", status: "completed", requirements: {}, changed_files: [], verification: [], findings: [], blocked_by: [], next: [] };

test("aria-execute dispatches the agent type the status names: the plugin's agent for an owner the project lacks", async () => {
	const team = executeTeam({ task: { id: "T1", owner: "test", agent_type: "aria-orchestrator:test" }, work: () => handoff });
	const { result } = await runWorkflow("aria-execute", { run: RUN }, team.agentImpl);
	assert.equal(result.ok, true, JSON.stringify(result));
	const work = team.calls.find((call) => call.label === "work:T1");
	assert.equal(work.agentType, "aria-orchestrator:test");
	// The handoff names the owner, the name accept compares with.
	assert.match(work.prompt, /"agent": "test"/);
});

test("aria-execute refuses an agent type that is neither the owner nor the plugin's agent of that name", async () => {
	for (const agentType of ["aria-orchestrator:security", "general-purpose", "other-plugin:test"]) {
		const team = executeTeam({ task: { id: "T1", owner: "test", agent_type: agentType }, work: () => handoff });
		const { result } = await runWorkflow("aria-execute", { run: RUN }, team.agentImpl);
		assert.equal(result.ok, false, agentType);
		assert.match(result.diagnosis, /invalid agent type/, agentType);
		assert.equal(team.calls.some((call) => call.label === "work:T1"), false, agentType);
	}
});

test("aria-execute records a failure when the owner's agent cannot even start", async () => {
	const team = executeTeam({
		task: { id: "T1", owner: "test", agent_type: "test" },
		work: () => {
			throw new Error("agent type not found");
		},
	});
	const { result } = await runWorkflow("aria-execute", { run: RUN }, team.agentImpl);
	const fail = team.calls.find((call) => call.label === "fail:T1");
	assert.ok(fail, "a failure is recorded instead of leaving the task running");
	assert.match(fail.prompt, /aria run fail .* T1 --category other --repro owner-agent-returned-null/);
	assert.equal(result.outcomes[0].accepted.ok, false);
});

test("aria-review asks for the exit code the Bash tool does not show", async () => {
	const prompts = [];
	const agentImpl = async (prompt, options) => {
		prompts.push({ label: options.label, prompt });
		if (options.label.startsWith("spec:")) return { spec: "0002-slugify-transliteration" };
		if (options.label.startsWith("gate:")) return { command: "x", exit_code: 0 };
		if (options.label.startsWith("scope:")) return { error: "no range" };
		return { findings: [], blocks_closing: false };
	};
	const { result } = await runWorkflow("aria-review", { run: RUN, checks: ["npm test"] }, agentImpl);
	assert.equal(result.ok, true, JSON.stringify(result));
	const gates = prompts.filter((entry) => entry.label.startsWith("gate:"));
	assert.equal(gates.length, 4);
	for (const gate of gates) {
		assert.match(gate.prompt, /; echo "aria-exit-code=\$\?"$/m, gate.label);
		assert.match(gate.prompt, /the number printed after aria-exit-code=/, gate.label);
	}
});

// Round 2: the security review ran against the last commit while the
// accepted change was still uncommitted, so it reviewed the wrong tree.
test("aria-review stops before the security review when the accepted change is not committed", async () => {
	const labels = [];
	const agentImpl = async (prompt, options) => {
		labels.push(options.label);
		if (options.label.startsWith("spec:")) return { spec: "0002-slugify-transliteration" };
		if (options.label.startsWith("gate:")) return { command: "x", exit_code: 0 };
		if (options.label.startsWith("scope:")) {
			assert.match(prompt, /git status --porcelain/);
			return { base: "a".repeat(40), head: "b".repeat(40), files: [], uncommitted: ["src/slugify.mjs", "test/slugify-transliteration.test.mjs"] };
		}
		return { findings: [], blocks_closing: false };
	};
	const { result } = await runWorkflow("aria-review", { run: RUN }, agentImpl);
	assert.equal(result.ok, false);
	assert.deepEqual(result.uncommitted, ["src/slugify.mjs", "test/slugify-transliteration.test.mjs"]);
	assert.match(result.next, /commit the accepted change/);
	assert.equal(labels.some((label) => label.startsWith("security:")), false);
});
