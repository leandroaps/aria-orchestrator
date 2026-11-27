// The approval end to end, with the plugin's real question hook: `run plan`
// gives the question, the hook records the owner's click, and
// `record-approval` accepts the event because its digest is the installed
// hook's.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { aria } from "./helpers/run-cli.mjs";
import { SPEC, workspace } from "./helpers/workspace.mjs";

const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOOK = fileURLToPath(new URL("../hooks/question-hook.mjs", import.meta.url));

function hook(root, payload) {
	const result = spawnSync(process.execPath, [HOOK], {
		input: JSON.stringify({
			session_id: "s1",
			transcript_path: "/tmp/t.jsonl",
			cwd: root,
			permission_mode: "default",
			tool_name: "AskUserQuestion",
			tool_use_id: "toolu_1",
			...payload,
		}),
		env: { ...process.env, CLAUDE_PROJECT_DIR: root, CLAUDE_CODE_ENTRYPOINT: "cli" },
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

const run = (root, argv) => aria(["run", ...argv, "--json"], { cwd: root, pluginRoot: PLUGIN_ROOT });

test("plan, the owner's click through the real hook, then record-approval", async (t) => {
	const root = workspace(t);
	const runId = run(root, ["create", SPEC]).json().run.run_id;
	const { approval_question: question } = run(root, ["plan", runId]).json();
	await sleep(5);
	assert.equal(hook(root, { hook_event_name: "PreToolUse", tool_input: { questions: [question] } }), "");
	hook(root, {
		hook_event_name: "PostToolUse",
		tool_input: { questions: [question] },
		tool_response: { questions: [question], answers: { [question.question]: question.options[0].label } },
	});
	const recorded = run(root, ["record-approval", runId]);
	assert.equal(recorded.code, 0, recorded.stdout);
	assert.equal(recorded.json().state, "approved");
	assert.equal(run(root, ["status", runId]).json().approval.valid, true);
});

test("a model-filled answer never reaches the registry, so nothing is approved", async (t) => {
	const root = workspace(t);
	const runId = run(root, ["create", SPEC]).json().run.run_id;
	const { approval_question: question } = run(root, ["plan", runId]).json();
	const prefilled = { questions: [question], answers: { [question.question]: question.options[0].label } };
	const denied = JSON.parse(hook(root, { hook_event_name: "PreToolUse", tool_input: prefilled }));
	assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
	// Even if the harness ran the tool anyway, no pre-check mark exists.
	hook(root, { hook_event_name: "PostToolUse", tool_input: prefilled, tool_response: prefilled });
	const recorded = run(root, ["record-approval", runId]);
	assert.equal(recorded.code, 1);
	assert.match(recorded.json().error, /last rejection: prefilled_answers|last rejection: pre_check_missing/);
});
