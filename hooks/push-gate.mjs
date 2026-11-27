#!/usr/bin/env node
// `PreToolUse` hook for `Bash`: the push gate (lib/push-gate.mjs). A refused
// push exits 2 with the reason on stderr, which Claude Code shows to Claude.
// An internal error refuses too; a command that is not a push never reaches
// the repository.

import { readFileSync } from "node:fs";
import { gate } from "../lib/push-gate.mjs";

let code = 0;
try {
	const payload = JSON.parse(readFileSync(0, "utf8") || "{}");
	if (payload.hook_event_name === "PreToolUse" && payload.tool_name === "Bash") {
		const result = gate({
			command: payload.tool_input?.command,
			cwd: payload.cwd || process.cwd(),
			projectDir: process.env.CLAUDE_PROJECT_DIR,
		});
		if (!result.allow) {
			process.stderr.write(`[aria push-gate] ${result.message}\n`);
			code = 2;
		}
	}
} catch (error) {
	process.stderr.write(`[aria push-gate] internal error: ${error.message}\n`);
	code = 2;
}
process.exit(code);
