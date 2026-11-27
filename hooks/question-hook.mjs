#!/usr/bin/env node
// `PreToolUse`/`PostToolUse` hook for `AskUserQuestion`. Plan 0001 P4, ported
// from bernardo-pet `scripts/agent-question-hook.mjs`.
//
// The only source of a plan approval: the owner clicks the yes option of a
// question in the fixed template (lib/approval-template.mjs). Claude Code
// accepts an `answers` map filled in by the model without showing the
// question, and it reaches `PostToolUse` exactly like a click. So:
//
// - `PreToolUse` denies any `tool_input` key besides `questions` (an allow
//   list) and, only after that check, writes the mark
//   `pre-checked/<session>-<tool_use>` for an approval question;
// - `PostToolUse` records an approval only when that mark exists, the
//   payload has the main interactive session's shape, and the question is
//   the exact template.
//
// The event carries this file's digest; `aria run record-approval` accepts
// only events whose digest matches the installed plugin's copy.
//
// It never emits `allow` or `updatedInput`: its only effect on the harness
// is to deny. An internal error does not deny an ordinary question, but
// writes no mark and no approval (closed for approval, open for use).

import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	APPROVAL_SOURCE,
	appendApproval,
	appendRejection,
	consumePreCheckMark,
	createPreCheckMark,
	resolveCommonDir,
} from "../lib/approval-registry.mjs";
import { looksLikeApproval, matchApprovalTemplate, noLabel, yesLabel } from "../lib/approval-template.mjs";

// The main session's payload shape. A key outside this list (`agent_id`,
// `agent_type`, or anything new from the harness) never approves.
const PAYLOAD_KEYS = new Set([
	"cwd",
	"duration_ms",
	"effort",
	"hook_event_name",
	"permission_mode",
	"prompt_id",
	"scratchpad_dir",
	"session_id",
	"tool_input",
	"tool_name",
	"tool_response",
	"tool_use_id",
	"transcript_path",
]);
const SUBAGENT_KEYS = ["agent_id", "agent_type", "parent_tool_use_id", "is_sidechain"];
const MODEL_INPUT_KEYS = new Set(["questions"]);
const ANSWERED_KEYS = new Set(["questions", "answers", "annotations"]);

function keysWithin(object, allowed) {
	return (
		Boolean(object) &&
		typeof object === "object" &&
		!Array.isArray(object) &&
		Object.keys(object).every((key) => allowed.has(key))
	);
}

function payloadShapeProblem(payload) {
	if (SUBAGENT_KEYS.some((key) => key in payload)) return "subagent";
	if (!Object.keys(payload).every((key) => PAYLOAD_KEYS.has(key))) return "unknown_payload_shape";
	return null;
}

function deny(reason) {
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: `[aria question-hook] ${reason}`,
		},
	};
}

// `PreToolUse`. Returns the hook output, or `null`.
export function decidePre(payload, { commonDir }) {
	const input = payload.tool_input;
	const malformed = !input || typeof input !== "object" || Array.isArray(input);
	// Mere presence is enough: there is no legitimate use of `answers: {}`.
	const extra = malformed ? ["tool_input"] : Object.keys(input).filter((key) => !MODEL_INPUT_KEYS.has(key));
	if (extra.length > 0) {
		// The denial comes first and does not depend on the registry.
		if (commonDir && looksLikeApproval(input)) {
			try {
				appendRejection(commonDir, { source: APPROVAL_SOURCE, reason: "prefilled_answers" });
			} catch {
				// Diagnostics lost; the denial stands.
			}
		}
		return deny(`prefilled answers or a field that is not allowed (${extra.join(", ")}): only the owner answers`);
	}
	if (!commonDir || !looksLikeApproval(input)) return null;
	if (payloadShapeProblem(payload) || matchApprovalTemplate(input) === null) return null;
	createPreCheckMark(commonDir, String(payload.session_id), String(payload.tool_use_id));
	return null;
}

// `PostToolUse`. Returns the line written (approval or rejection), or `null`
// when the question was not an approval or the owner said no.
export function decidePost(payload, { commonDir, entrypoint, hookDigest }) {
	const input = payload.tool_input;
	if (!commonDir || !looksLikeApproval(input)) return null;
	const reject = (reason) => appendRejection(commonDir, { source: APPROVAL_SOURCE, reason });

	const shape = payloadShapeProblem(payload);
	if (shape) return reject(shape);
	if (entrypoint !== "cli") return reject("non_interactive");
	if (!consumePreCheckMark(commonDir, String(payload.session_id), String(payload.tool_use_id))) {
		return reject("pre_check_missing");
	}
	const response = payload.tool_response;
	if (!keysWithin(input, ANSWERED_KEYS) || !keysWithin(response, ANSWERED_KEYS)) {
		return reject("unknown_payload_shape");
	}
	if (JSON.stringify(input.questions) !== JSON.stringify(response.questions)) {
		return reject("unknown_payload_shape");
	}
	const template = matchApprovalTemplate(response);
	if (!template) return reject("template_mismatch");
	const answers = response.answers;
	if (!keysWithin(answers, new Set([template.text])) || Object.keys(answers).length !== 1) {
		return reject("unknown_payload_shape");
	}
	const chosen = answers[template.text];
	if (chosen === noLabel(template.locale)) return null;
	if (chosen !== yesLabel(template.prefix, template.locale)) return reject("label_mismatch");
	return appendApproval(commonDir, { approves: template.prefix, runId: template.runId, hookDigest });
}

function selfDigest() {
	return createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex");
}

function runHook() {
	let payload;
	try {
		payload = JSON.parse(readFileSync(0, "utf8"));
	} catch {
		return;
	}
	if (payload?.tool_name !== "AskUserQuestion") return;
	// Only `CLAUDE_PROJECT_DIR`, set by the harness; `payload.cwd` follows the
	// model's `cd`.
	const commonDir = resolveCommonDir(process.env.CLAUDE_PROJECT_DIR);
	if (payload.hook_event_name === "PreToolUse") {
		const result = decidePre(payload, { commonDir });
		if (result) process.stdout.write(JSON.stringify(result));
		return;
	}
	if (payload.hook_event_name === "PostToolUse") {
		decidePost(payload, {
			commonDir,
			entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
			hookDigest: selfDigest(),
		});
	}
}

// Acts as a hook only when run directly; imported (tests), it exposes the
// functions without reading stdin or exiting.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	try {
		runHook();
	} catch {
		// Open for use; no mark and no approval was written.
	}
	process.exit(0);
}
