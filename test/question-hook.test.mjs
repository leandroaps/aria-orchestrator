// The approval question: its fixed template (lib/approval-template.mjs) and
// the question hook, the only source of an approval event.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readRegistry, resolveCommonDir } from "../lib/approval-registry.mjs";
import { approvalQuestion, looksLikeApproval, matchApprovalTemplate } from "../lib/approval-template.mjs";
import { decidePost, decidePre } from "../hooks/question-hook.mjs";
import { workspace } from "./helpers/workspace.mjs";

const HOOK = fileURLToPath(new URL("../hooks/question-hook.mjs", import.meta.url));
const RUN = "20261127T120000Z-abcdef";
const PREFIX = "0123456789ab";
const SPEC = "0001-fixture";

const question = (locale = "en") => approvalQuestion({ runId: RUN, spec: SPEC, prefix: PREFIX }, locale);

function payload(event, { input = { questions: [question()] }, response, extra = {} } = {}) {
	return {
		session_id: "session-1",
		transcript_path: "/tmp/t.jsonl",
		cwd: "/tmp",
		permission_mode: "default",
		hook_event_name: event,
		tool_name: "AskUserQuestion",
		tool_input: input,
		tool_use_id: "toolu_01",
		...(response === undefined ? {} : { tool_response: response }),
		...extra,
	};
}

function answered(label, q = question()) {
	return { questions: [q], answers: { [q.question]: label } };
}

const POST = (commonDir) => ({ commonDir, entrypoint: "cli", hookDigest: "c".repeat(64) });

// --- Template --------------------------------------------------------------------

test("the template, in English and Brazilian Portuguese", () => {
	assert.deepEqual(question("en"), {
		question: `Approve the plan of run ${RUN} (spec ${SPEC}), digest ${PREFIX}?`,
		header: "Approval",
		multiSelect: false,
		options: [
			{ label: `Yes, approve ${PREFIX}`, description: "Records the approval of this plan in the controller." },
			{ label: "No", description: "The run stays in awaiting_approval." },
		],
	});
	assert.equal(question("pt-BR").options[0].label, `Sim, aprovo ${PREFIX}`);
	assert.throws(() => approvalQuestion({ runId: RUN, spec: SPEC, prefix: PREFIX }, "fr"), /locale/);
});

test("matching: the exact template of either locale, and nothing else", () => {
	for (const locale of ["en", "pt-BR"]) {
		assert.deepEqual(matchApprovalTemplate({ questions: [question(locale)] }), {
			runId: RUN,
			spec: SPEC,
			prefix: PREFIX,
			locale,
			text: question(locale).question,
		});
	}
	const tampered = [
		{ ...question(), header: "Approve" },
		{ ...question(), multiSelect: true },
		{ ...question(), extra: 1 },
		{ ...question(), options: [question().options[0]] },
		{ ...question(), options: [{ ...question().options[0], label: "Yes, approve ffffffffffff" }, question().options[1]] },
		{ ...question(), options: [question().options[0], { label: "No", description: "x" }] },
		{ ...question(), question: `Approve the plan of run ${RUN} (spec ${SPEC}), digest ${PREFIX}? ` },
	];
	for (const candidate of tampered) assert.equal(matchApprovalTemplate({ questions: [candidate] }), null);
	assert.equal(matchApprovalTemplate({ questions: [question(), question()] }), null);
	// Mixed locales do not match.
	assert.equal(matchApprovalTemplate({ questions: [{ ...question("en"), header: "Aprovação" }] }), null);
});

test("looks like an approval: an approval header, or an approve label", () => {
	assert.equal(looksLikeApproval({ questions: [question()] }), true);
	assert.equal(looksLikeApproval({ questions: [{ question: "x", header: "Aprovação", options: [] }] }), true);
	assert.equal(
		looksLikeApproval({ questions: [{ question: "x", header: "h", options: [{ label: "I approve it" }] }] }),
		true,
	);
	assert.equal(
		looksLikeApproval({ questions: [{ question: "Which spec?", header: "Spec", options: [{ label: "0001" }] }] }),
		false,
	);
});

// --- PreToolUse -------------------------------------------------------------------

test("pre: prefilled answers are denied and logged when the question is an approval", (t) => {
	const commonDir = resolveCommonDir(workspace(t));
	const result = decidePre(payload("PreToolUse", { input: answered(question().options[0].label) }), { commonDir });
	assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
	assert.match(result.hookSpecificOutput.permissionDecisionReason, /^\[aria question-hook\] .*answers/);
	assert.deepEqual(
		readRegistry(commonDir).rejections.map((line) => line.rejected),
		["prefilled_answers"],
	);
});

test("pre: any key besides questions is denied, even on an ordinary question", (t) => {
	const commonDir = resolveCommonDir(workspace(t));
	const ordinary = { questions: [{ question: "Which spec?", header: "Spec", options: [{ label: "A", description: "a" }] }] };
	assert.equal(decidePre(payload("PreToolUse", { input: ordinary }), { commonDir }), null);
	const result = decidePre(payload("PreToolUse", { input: { ...ordinary, annotations: {} } }), { commonDir });
	assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
	assert.equal(readRegistry(commonDir).rejections.length, 0, "an ordinary question logs nothing");
});

test("pre then post: the owner's yes records an approval with the hook digest", (t) => {
	const commonDir = resolveCommonDir(workspace(t));
	assert.equal(decidePre(payload("PreToolUse"), { commonDir }), null);
	const line = decidePost(payload("PostToolUse", { response: answered(question().options[0].label) }), POST(commonDir));
	assert.equal(line.approves, PREFIX);
	assert.equal(line.run_id, RUN);
	assert.equal(line.hook_digest, "c".repeat(64));
	assert.equal(readRegistry(commonDir).approvals.length, 1);
});

test("post: the pt-BR yes approves too", (t) => {
	const commonDir = resolveCommonDir(workspace(t));
	const q = question("pt-BR");
	decidePre(payload("PreToolUse", { input: { questions: [q] } }), { commonDir });
	const line = decidePost(
		payload("PostToolUse", { input: { questions: [q] }, response: answered(`Sim, aprovo ${PREFIX}`, q) }),
		POST(commonDir),
	);
	assert.equal(line.approves, PREFIX);
});

test("post: No records nothing", (t) => {
	const commonDir = resolveCommonDir(workspace(t));
	decidePre(payload("PreToolUse"), { commonDir });
	assert.equal(decidePost(payload("PostToolUse", { response: answered("No") }), POST(commonDir)), null);
	const registry = readRegistry(commonDir);
	assert.equal(registry.approvals.length + registry.rejections.length, 0);
});

test("post: refused without the pre-check mark, for a subagent, outside the CLI, or with another label", (t) => {
	const commonDir = resolveCommonDir(workspace(t));
	const yes = answered(question().options[0].label);
	const cases = [
		["pre_check_missing", payload("PostToolUse", { response: yes }), POST(commonDir), false],
		["subagent", payload("PostToolUse", { response: yes, extra: { agent_id: "a1", agent_type: "backend" } }), POST(commonDir), true],
		["non_interactive", payload("PostToolUse", { response: yes }), { ...POST(commonDir), entrypoint: "sdk-ts" }, true],
		["unknown_payload_shape", payload("PostToolUse", { response: yes, extra: { surprise: 1 } }), POST(commonDir), true],
		["label_mismatch", payload("PostToolUse", { response: answered("Yes") }), POST(commonDir), true],
		[
			"unknown_payload_shape",
			payload("PostToolUse", { response: { ...yes, answers: { ...yes.answers, other: "x" } } }),
			POST(commonDir),
			true,
		],
	];
	for (const [index, [reason, event, options, withMark]] of cases.entries()) {
		const id = `toolu_${index}`;
		if (withMark) decidePre({ ...payload("PreToolUse"), tool_use_id: id }, { commonDir });
		const line = decidePost({ ...event, tool_use_id: id }, options);
		assert.equal(line?.rejected, reason, reason);
	}
	assert.equal(readRegistry(commonDir).approvals.length, 0);
});

// --- As a process -----------------------------------------------------------------

test("as a hook: reads stdin, records through CLAUDE_PROJECT_DIR, never prints an allow", (t) => {
	const root = workspace(t);
	const env = { ...process.env, CLAUDE_PROJECT_DIR: root, CLAUDE_CODE_ENTRYPOINT: "cli" };
	const pre = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload("PreToolUse")), env, encoding: "utf8" });
	assert.equal(pre.status, 0);
	assert.equal(pre.stdout, "");
	const post = spawnSync(process.execPath, [HOOK], {
		input: JSON.stringify(payload("PostToolUse", { response: answered(question().options[0].label) })),
		env,
		encoding: "utf8",
	});
	assert.equal(post.status, 0);
	const [approval] = readRegistry(resolveCommonDir(root)).approvals;
	assert.equal(approval.hook_digest, createHash("sha256").update(readFileSync(HOOK)).digest("hex"));
	const denied = spawnSync(process.execPath, [HOOK], {
		input: JSON.stringify(payload("PreToolUse", { input: answered("x") })),
		env,
		encoding: "utf8",
	});
	assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
	const junk = spawnSync(process.execPath, [HOOK], { input: "not json", env, encoding: "utf8" });
	assert.equal(junk.status, 0);
	assert.equal(junk.stdout, "");
});
