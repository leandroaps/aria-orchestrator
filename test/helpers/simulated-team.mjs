// The agents of a run, simulated as obedient models inside a simulated
// Claude Code: each one reads its prompt, runs the commands the prompt names
// and returns the fields its schema asks for. Every write and every command
// first passes through the real tool guard with the agent's identity, as the
// `PreToolUse` hook would; a denied call does not happen and is logged.
//
// Workers are supplied by the test, so a scenario can make one misbehave.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decide } from "../../hooks/tool-guard.mjs";
import { aria } from "./run-cli.mjs";

export const PLUGIN_ROOT = join(import.meta.dirname, "..", "..");
const CONTROLLER = "aria-orchestrator:controller";
const SECURITY = "aria-orchestrator:security";

function words(command) {
	return command.trim().split(/\s+/);
}

export function simulatedTeam(root, { worker }) {
	const guardLog = [];
	let nextId = 0;

	function guard(agentType, tool, input) {
		const payload = { cwd: root, agent_id: `agent-${(nextId += 1)}`, agent_type: agentType, tool_name: tool, tool_input: input };
		const verdict = decide(payload, { root })?.hookSpecificOutput;
		const denied = verdict?.permissionDecision === "deny";
		guardLog.push({ agentType, tool, target: input.file_path ?? input.command, denied, reason: verdict?.permissionDecisionReason });
		return !denied;
	}

	// Runs one command as `agentType`. `aria` runs in-process with the
	// installed plugin's root; anything else runs in a shell at the root.
	function exec(agentType, command) {
		if (!guard(agentType, "Bash", { command })) return { code: null, denied: true, json: null };
		const argv = words(command);
		if (argv[0] === "aria") {
			const result = aria(argv.slice(1), { cwd: root, pluginRoot: PLUGIN_ROOT });
			let json = null;
			try {
				json = result.json();
			} catch {}
			return { code: result.code, json, stdout: result.stdout };
		}
		const result = spawnSync("sh", ["-c", command], { cwd: root, encoding: "utf8" });
		return { code: result.status, json: null, stdout: result.stdout };
	}

	function write(agentType, path, content) {
		if (!guard(agentType, "Write", { file_path: join(root, path) })) return false;
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
		return true;
	}

	// The commands a prompt names, one per line, wherever they start in it
	// ("2. Only if (1) reported ok: aria run create …").
	const commandLines = (prompt) =>
		prompt
			.split("\n")
			.map((line) => line.match(/(?:^|[\s:])(aria\s.*)$/)?.[1]?.trim())
			.filter(Boolean);
	const lastLine = (prompt) => prompt.trim().split("\n").at(-1).trim();

	function controller(prompt, label) {
		const [kind] = label.split(":");
		if (kind === "graph") {
			const [validate, create, plan] = commandLines(prompt);
			const graph = exec(CONTROLLER, validate);
			if (graph.code !== 0) return { graph_ok: false, graph_output: graph.stdout };
			const created = exec(CONTROLLER, create);
			if (created.code !== 0) return { graph_ok: true, error: created.stdout };
			const planned = exec(CONTROLLER, plan.replace(/<[^>]+>/, created.json.run.run_id));
			if (planned.code !== 0) return { graph_ok: true, error: planned.stdout };
			const status = exec(CONTROLLER, `aria run status ${created.json.run.run_id} --json`).json;
			return {
				graph_ok: true,
				graph_output: graph.stdout,
				run_id: planned.json.run_id ?? created.json.run.run_id,
				state: status.state,
				plan_digest: planned.json.plan_digest,
				approval_prefix: planned.json.approval_prefix,
				approval_question: planned.json.approval_question,
				tasks: planned.json.tasks,
			};
		}
		if (kind === "impact") {
			// The model writes the list to a scratch file outside the repository.
			const list = prompt.match(/printf '%s' '(\[.*\])'/)[1];
			const file = join(mkdtempSync(join(tmpdir(), "aria-impact-")), "files.json");
			writeFileSync(file, list);
			return exec(CONTROLLER, `aria classify --files ${file} --json`).json;
		}
		if (kind === "status") {
			const summary = exec(CONTROLLER, commandLines(prompt)[0]).json;
			return {
				state: summary.state,
				approval_valid: summary.approval.valid,
				approval_reasons: summary.approval.reasons,
				dispatchable: summary.dispatchable,
				tasks: summary.tasks.map(({ id, owner, agent_type, state, reasons }) => ({ id, owner, agent_type, state, reasons })),
			};
		}
		if (kind === "spec") return { spec: exec(CONTROLLER, commandLines(prompt)[0]).json.spec };
		if (kind === "gate") {
			// The line prints the exit code; an obedient model reads it back.
			const line = lastLine(prompt);
			const command = line.replace(/; echo "aria-exit-code=\$\?"$/, "");
			assert.notEqual(command, line, "the gate prompt asks for the exit code");
			return { command, exit_code: exec(CONTROLLER, command).code };
		}
		if (kind === "scope") {
			const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
			const base = git(["merge-base", "origin/HEAD", "HEAD"]);
			const head = git(["rev-parse", "HEAD"]);
			const files = git(["diff", "--name-only", base, head]).split("\n").filter(Boolean);
			const uncommitted = git(["status", "--porcelain"]).split("\n").filter(Boolean).map((line) => line.slice(3));
			return { base, head, files, uncommitted };
		}
		if (kind === "accept") {
			const file = prompt.match(/Write this exact JSON to (\S+)/)[1];
			const json = prompt.slice(prompt.lastIndexOf("JSON:\n") + "JSON:\n".length);
			if (!write(CONTROLLER, file, json)) return { ok: false, error: "the guard denied the handoff write" };
			const result = exec(CONTROLLER, commandLines(prompt).find((line) => line.startsWith("aria run accept")));
			return result.json;
		}
		// start, fail: the command is the prompt's last line.
		const result = exec(CONTROLLER, lastLine(prompt));
		return result.json ?? { ok: false, error: "the command did not run" };
	}

	async function agentImpl(prompt, options) {
		const { agentType, label = "" } = options;
		if (agentType === "Explore") return { status: "pass", divergences: [], high_impact: false };
		if (agentType === CONTROLLER) return controller(prompt, label);
		if (agentType === SECURITY) {
			return label.startsWith("security:") ? { findings: [], blocks_dispatch: false, blocks_closing: false } : null;
		}
		const [, taskId] = label.split(":");
		return worker({
			owner: agentType,
			taskId,
			prompt,
			write: (path, content) => write(agentType, path, content),
			bash: (command) => exec(agentType, command),
		});
	}

	return { agentImpl, guardLog };
}

// The handoff an honest worker returns.
export function handoff({ owner, taskId, files, requirement }) {
	return {
		agent: owner,
		task: taskId,
		status: "completed",
		requirements: { [requirement]: "ok" },
		evidence: { [requirement]: "node tools/check.mjs" },
		changed_files: files,
		verification: [{ command: "node tools/check.mjs", status: "passed" }],
		findings: [],
		blocked_by: [],
		next: [],
	};
}
