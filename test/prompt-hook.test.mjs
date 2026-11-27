// The prompt hook: a typed "approve <prefix>" never approves; it is logged
// as a rejection so record-approval can say why the run still waits.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readRegistry, resolveCommonDir } from "../lib/approval-registry.mjs";
import { workspace } from "./helpers/workspace.mjs";

const HOOK = fileURLToPath(new URL("../hooks/prompt-hook.mjs", import.meta.url));

function prompt(root, text, extra = {}) {
	return spawnSync(process.execPath, [HOOK], {
		input: JSON.stringify({ session_id: "s", hook_event_name: "UserPromptSubmit", prompt: text, ...extra }),
		env: { ...process.env, CLAUDE_PROJECT_DIR: root },
		encoding: "utf8",
	});
}

test("a typed approval marker is logged as source_not_user, never as an approval", (t) => {
	const root = workspace(t);
	for (const text of ["approve 0123456789ab", "  aprovo 0123456789AB  "]) {
		const result = prompt(root, text);
		assert.equal(result.status, 0);
		assert.equal(result.stdout, "");
	}
	const registry = readRegistry(resolveCommonDir(root));
	assert.equal(registry.approvals.length, 0);
	assert.deepEqual(registry.rejections.map((line) => [line.source, line.rejected]), [
		["UserPromptSubmit", "source_not_user"],
		["UserPromptSubmit", "source_not_user"],
	]);
	// Neither the text nor a hash of it is stored.
	assert.doesNotMatch(JSON.stringify(registry), /0123456789ab/i);
});

test("any other prompt, or junk input, passes untouched", (t) => {
	const root = workspace(t);
	for (const text of ["I don't approve 0123456789ab", "approve it", "hello"]) {
		assert.equal(prompt(root, text).stdout, "");
	}
	const junk = spawnSync(process.execPath, [HOOK], { input: "{", env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: "utf8" });
	assert.equal(junk.status, 0);
	assert.equal(readRegistry(resolveCommonDir(root)).rejections.length, 0);
});
