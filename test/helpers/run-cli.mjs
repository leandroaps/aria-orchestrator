// In-process `aria` for the run tests: a plugin root whose question hook
// the tests know, and a terminal that is not a TTY unless a test says so.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { main } from "../../bin/aria.mjs";
import { appendApproval, resolveCommonDir } from "../../lib/approval-registry.mjs";
import { SPEC, writeFile } from "./workspace.mjs";

export const PLAIN_TERMINAL = { env: {}, isTTY: false, platform: "darwin" };

export const HOOK_SOURCE = "// question hook used by the tests\n";
export const HOOK_DIGEST = createHash("sha256").update(HOOK_SOURCE).digest("hex");
export const PLUGIN = realpathSync(mkdtempSync(join(tmpdir(), "aria-plugin-")));
writeFile(PLUGIN, "hooks/question-hook.mjs", HOOK_SOURCE);
after(() => rmSync(PLUGIN, { recursive: true, force: true }));

export function aria(argv, { cwd, pluginRoot = PLUGIN, terminal = PLAIN_TERMINAL } = {}) {
	const stdout = [];
	const stderr = [];
	const out = { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) };
	const code = main(argv, out, { cwd, pluginRoot, terminal });
	return {
		code,
		stdout: stdout.join("\n"),
		stderr: stderr.join("\n"),
		json: () => JSON.parse(stdout.join("\n")),
	};
}

// JSON mode, inside the workspace.
export function run(root, argv, options = {}) {
	return aria(["run", ...argv, "--json"], { cwd: root, ...options });
}

export function create(root) {
	const result = run(root, ["create", SPEC]);
	assert.equal(result.code, 0, result.stdout + result.stderr);
	return result.json().run.run_id;
}

// Presents the plan, then writes the owner's click strictly after it.
export async function presentAndClick(root, runId, { hookDigest = HOOK_DIGEST } = {}) {
	const plan = run(root, ["plan", runId]);
	assert.equal(plan.code, 0, plan.stdout + plan.stderr);
	await sleep(5);
	return appendApproval(resolveCommonDir(root), {
		approves: plan.json().approval_prefix,
		runId,
		hookDigest,
	});
}

export async function approvedRun(root) {
	const runId = create(root);
	await presentAndClick(root, runId);
	const recorded = run(root, ["record-approval", runId]);
	assert.equal(recorded.code, 0, recorded.stdout + recorded.stderr);
	return runId;
}

export function handoff(root, name, body) {
	const path = join(root, ".aria", name);
	writeFile(root, join(".aria", name), JSON.stringify(body));
	return path;
}

export const HANDOFF_T1 = {
	task: "T1",
	agent: "backend",
	status: "completed",
	changed_files: ["src/lib/new.txt"],
	requirements: { "R1.1": "ok" },
	evidence: { "R1.1": "node tools/check.mjs" },
};
