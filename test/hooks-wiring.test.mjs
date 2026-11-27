// hooks/hooks.json: which hook runs on which event, and how it fails.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const { hooks } = JSON.parse(readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8"));

function entries(event) {
	return (hooks[event] ?? []).flatMap((group) =>
		group.hooks.map((hook) => ({ matcher: group.matcher, ...hook, file: hook.command.match(/hooks\/([\w-]+\.mjs)/)?.[1] })),
	);
}

test("every hook command runs a file of this plugin through CLAUDE_PLUGIN_ROOT", () => {
	for (const event of Object.keys(hooks)) {
		for (const hook of entries(event)) {
			assert.equal(hook.type, "command");
			assert.match(hook.command, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/[\w-]+\.mjs"( \|\| exit 2)?$/, hook.command);
			assert.ok(existsSync(new URL(`../hooks/${hook.file}`, import.meta.url)), hook.file);
			assert.ok(Number.isInteger(hook.timeout) && hook.timeout > 0, hook.command);
		}
	}
});

test("PreToolUse guards fail closed: a crash blocks the tool", () => {
	const pre = entries("PreToolUse");
	const guard = pre.find((hook) => hook.file === "tool-guard.mjs");
	assert.equal(guard.matcher, "Write|Edit|MultiEdit|NotebookEdit|Bash|mcp__.*");
	assert.match(guard.command, /\|\| exit 2$/);
	const gate = pre.find((hook) => hook.file === "push-gate.mjs");
	assert.equal(gate.matcher, "Bash");
	assert.match(gate.command, /\|\| exit 2$/);
	assert.equal(gate.timeout, 300);
	const question = pre.find((hook) => hook.file === "question-hook.mjs");
	assert.equal(question.matcher, "AskUserQuestion");
	assert.match(question.command, /\|\| exit 2$/);
});

test("the approval hooks and the Stop guard are wired", () => {
	assert.deepEqual(entries("PostToolUse").map((hook) => [hook.matcher, hook.file]), [["AskUserQuestion", "question-hook.mjs"]]);
	assert.deepEqual(entries("UserPromptSubmit").map((hook) => hook.file), ["prompt-hook.mjs"]);
	assert.deepEqual(entries("Stop").map((hook) => hook.file), ["tool-guard.mjs"]);
	assert.deepEqual(entries("SubagentStop").map((hook) => hook.file), ["tool-guard.mjs"]);
	// A failed PostToolUse or prompt hook never blocks the owner.
	for (const event of ["PostToolUse", "UserPromptSubmit", "Stop", "SubagentStop"]) {
		for (const hook of entries(event)) assert.doesNotMatch(hook.command, /exit 2/, event);
	}
});
