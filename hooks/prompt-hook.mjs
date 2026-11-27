#!/usr/bin/env node
// `UserPromptSubmit` hook. Plan 0001 P4, ported from bernardo-pet
// `scripts/agent-prompt-hook.mjs`.
//
// Nothing in this payload separates what the owner typed from a `/loop`
// tick, a wakeup or a scheduled task, which the model chooses. So a typed
// "approve <prefix>" approves nothing: the hook only logs a
// `source_not_user` rejection in the shared registry, so that
// `aria run record-approval` can explain why the run still waits. The
// approval is the click on the approval question (hooks/question-hook.mjs).
//
// It records the id, instant, source and reason only: never the prompt text
// or a hash of it. Open for the prompt: any error exits 0 silently.

import { readFileSync } from "node:fs";
import { appendRejection, resolveCommonDir } from "../lib/approval-registry.mjs";
import { APPROVAL_MARKER_PATTERN } from "../lib/run-state.mjs";

function main() {
	let payload;
	try {
		payload = JSON.parse(readFileSync(0, "utf8"));
	} catch {
		return;
	}
	if (payload?.hook_event_name !== "UserPromptSubmit") return;
	if (typeof payload.prompt !== "string" || !APPROVAL_MARKER_PATTERN.test(payload.prompt)) return;
	// Only `CLAUDE_PROJECT_DIR`, set by the harness; `payload.cwd` follows the
	// model's `cd`.
	const commonDir = resolveCommonDir(process.env.CLAUDE_PROJECT_DIR);
	if (!commonDir) return;
	appendRejection(commonDir, { source: "UserPromptSubmit", reason: "source_not_user" });
}

try {
	main();
} catch {
	// Open for the prompt.
}
process.exit(0);
