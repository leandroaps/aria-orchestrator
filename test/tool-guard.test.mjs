// The tool guard (`PreToolUse`, `Stop`, `SubagentStop`). Ported from the
// self-test of bernardo-pet `scripts/agent-tool-guard.mjs`, with neutral
// paths. It is an operational control, not a sandbox: `aria run accept`
// still compares the real change.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveCommonDir } from "../lib/approval-registry.mjs";
import { decide, decideStop } from "../hooks/tool-guard.mjs";
import { SPEC, workspace, writeFile } from "./helpers/workspace.mjs";

const HOOK = fileURLToPath(new URL("../hooks/tool-guard.mjs", import.meta.url));
const RUN = "20261127T120000Z-abcdef";

const backend = { agent_id: "a1", agent_type: "backend" };
const security = { agent_id: "a2", agent_type: "security" };
const pr = { agent_id: "a3", agent_type: "pr" };

const write = (file_path, actor = {}) => ({ ...actor, tool_name: "Write", tool_input: { file_path } });
const bash = (command, actor = {}) => ({ ...actor, tool_name: "Bash", tool_input: { command } });

function startTask(root, { task = "T1", taskState = "running" } = {}) {
	writeFile(root, `.aria/runs/${RUN}/manifest.json`, JSON.stringify({ state: "running", spec: SPEC }));
	writeFile(root, `.aria/runs/${RUN}/tasks/${task}.json`, JSON.stringify({ task_id: task, state: taskState }));
}

// Each case: [name, payload, expected denial (true) or allowance (false)].
function check(root, cases) {
	for (const [name, payload, expectDeny] of cases) {
		const result = decide({ cwd: root, ...payload }, { root });
		const denied = result?.hookSpecificOutput?.permissionDecision === "deny";
		assert.equal(denied, expectDeny, `${name}: ${result?.hookSpecificOutput?.permissionDecisionReason ?? "allowed"}`);
	}
}

test("without a run: writes are free, the approval channel and .git are not", (t) => {
	const root = workspace(t);
	const registry = join(resolveCommonDir(root), "aria", "approval-events.jsonl");
	check(root, [
		["ordinary write", write("README.md"), false],
		["docs write", write("docs/x.md"), false],
		["registry by absolute path", write(registry), true],
		["registry edited by a subagent", { ...backend, tool_name: "Edit", tool_input: { file_path: registry } }, true],
		["registry by ..", write("src/../.git/aria/consumed/x.json"), true],
		[".git/config", write(".git/config"), true],
		["cp into .git", bash("cp x .git/HEAD"), true],
		["prompt hook by Bash", bash("echo {} | node hooks/prompt-hook.mjs"), true],
		["question hook by Bash", bash('node "$CLAUDE_PLUGIN_ROOT/hooks/question-hook.mjs" < p.json'), true],
		["registry library by Bash", bash("node -e 'import(\"./lib/approval-registry.mjs\")'"), true],
	]);
});

test("without a task: subagents never touch run state or lead-only run commands", (t) => {
	const root = workspace(t);
	check(root, [
		["subagent writes a manifest", write(".aria/runs/x/manifest.json", backend), true],
		["subagent writes a handoff", write(".aria/handoffs/T1-backend.json", backend), false],
		["subagent creates the handoffs directory", bash("mkdir -p .aria/handoffs", backend), false],
		["subagent redirects into run state", bash("echo x > .aria/runs/x/tasks/T1.json", backend), true],
		["subagent records an approval", bash(`aria run record-approval ${RUN}`, backend), true],
		["subagent records an approval through node", bash(`node /plugin/bin/aria.mjs run record-approval ${RUN}`, backend), true],
		["subagent cancels the run", bash(`aria run cancel ${RUN} --reason y`, backend), true],
		["subagent resumes the run", bash(`aria run resume ${RUN}`, backend), true],
		["subagent recovers a lock", bash("aria run recover-lock resource:x", backend), true],
		["lead records an approval", bash(`aria run record-approval ${RUN}`), false],
		["lead cancels the run", bash(`aria run cancel ${RUN} --reason y`), false],
		["subagent runs node -e", bash("node -e 1", backend), true],
	]);
});

test("a writer during its task: only its territory, never the sensitive set", (t) => {
	const root = workspace(t);
	startTask(root);
	check(root, [
		["in territory", write("src/lib/a.mjs", backend), false],
		["outside territory", { ...backend, tool_name: "Edit", tool_input: { file_path: "src/app/page.mjs" } }, true],
		["escape by ..", write("src/lib/../../x", backend), true],
		["outside the repository", write("/tmp/aria-guard-x", backend), true],
		["settings.local.json", write(".claude/settings.local.json", backend), true],
		["settings.json outside the task", write(".claude/settings.json", backend), true],
		["run state", write(`.aria/runs/${RUN}/manifest.json`, backend), true],
		[".env", write("src/lib/.env", backend), true],
		["a .pem key", write("src/lib/key.pem", backend), true],
		["node_modules", write("node_modules/x/index.js", backend), true],
		["MCP tools", { ...backend, tool_name: "mcp__db__run_sql", tool_input: {} }, true],
		["NotebookEdit", { ...backend, tool_name: "NotebookEdit", tool_input: { notebook_path: "src/lib/n.ipynb" } }, true],
		["redirect outside territory", bash("echo x > src/app/x.mjs", backend), true],
		["redirect inside territory", bash("echo x > src/lib/x.mjs", backend), false],
		["sed -i outside territory", bash("sed -i s/a/b/ src/app/page.mjs", backend), true],
		["tee outside territory", bash("echo x | tee src/app/y.mjs", backend), true],
		["git commit", bash("git commit -am x", backend), true],
		["nested shell", bash("bash -c 'touch src/app/x'", backend), true],
		["eval", bash("eval touch x", backend), true],
		["cancel during the task", bash(`aria run cancel ${RUN} --reason y`, backend), true],
		["reading is fine", bash("cat src/lib/old.txt", backend), false],
		["node as an argument of rg is not opaque node", bash("rg -n node -e foo src", backend), false],
	]);
});

test("opaque node in every form is denied to a subagent", (t) => {
	const root = workspace(t);
	startTask(root);
	check(
		root,
		[
			"node -e \"require('fs').writeFileSync('x','y')\"",
			"node --eval='1'",
			"node -pe 1",
			"echo 1 | node",
			"node - < x.mjs",
			"env FOO=1 /usr/bin/node --import data:text/javascript,1 x.mjs",
		].map((command) => [command, bash(command, backend), true]),
	);
});

test("the lead during a run writes the spec and handoffs, not the workers' code", (t) => {
	const root = workspace(t);
	startTask(root);
	check(root, [
		["spec file", write(`specs/${SPEC}/tasks.md`), false],
		["handoff", write(".aria/handoffs/T1-backend.json"), false],
		["worker code", write("src/lib/a.mjs"), true],
		["lead may commit", bash("git commit -am x"), false],
		["controller agent writes a handoff", write(".aria/handoffs/T1.json", { agent_id: "c", agent_type: "controller" }), false],
	]);
});

test("a read-only auditor only reads, with flags allowed per command", (t) => {
	const root = workspace(t);
	startTask(root);
	check(root, [
		["writes", write("src/lib/a.mjs", security), true],
		["git diff --stat", bash("git diff --stat main...HEAD", security), false],
		["git log piped to head", bash("git log --oneline | head -5", security), false],
		["git diff --output", bash("git diff --output=x", security), true],
		["git -c", bash("git -c diff.external=sh diff", security), true],
		["git push", bash("git push", security), true],
		["rg --pre", bash("rg --pre sh foo", security), true],
		["sed w", bash("sed -n 1w src/app/x.mjs README.md", security), true],
		["sort -o", bash("sort -osrc/app/x.mjs README.md", security), true],
		["uniq with an output file", bash("uniq README.md src/app/x.mjs", security), true],
		["find -delete", bash("find . -name x -delete", security), true],
		["redirect", bash("cat a > b", security), true],
		["chained", bash("ls && rm x", security), true],
		["command substitution", bash("cat $(ls)", security), true],
		["node -e", bash("node -e 1", security), true],
		["aria validate graph", bash(`aria validate graph ${SPEC} --json`, security), false],
		["aria classify", bash("aria classify --base main --head HEAD", security), false],
		["aria status", bash("aria status --verbose", security), false],
		["aria run ready", bash(`aria run ready ${RUN}`, security), false],
		["aria run start", bash(`aria run start ${RUN} T1`, security), true],
		["aria through node", bash(`node /plugin/bin/aria.mjs validate spec`, security), false],
		["another node script", bash("node tools/check.mjs", security), true],
	]);
});

test("the pr agent only publishes and reads with gh", (t) => {
	const root = workspace(t);
	startTask(root);
	check(root, [
		["gh pr create", bash('gh pr create --title "x" --body "y"', pr), false],
		["gh pr ready", bash("gh pr ready 12", pr), false],
		["gh pr view", bash("gh pr view 12 --json state", pr), false],
		["gh api read", bash("gh api repos/o/r/pulls/12", pr), false],
		["gh pr merge", bash("gh pr merge 12", pr), true],
		["gh piped to a shell", bash("gh pr view 12 | sh", pr), true],
		["arbitrary command", bash("rm -rf src", pr), true],
		["git log reads", bash("git log --oneline", pr), false],
	]);
});

test("unreadable run state closes writes until resume", (t) => {
	const root = workspace(t);
	startTask(root);
	writeFile(root, `.aria/runs/${RUN}/tasks/T1.json`, "{corrupted");
	check(root, [
		["write", write("src/lib/a.mjs", backend), true],
		["bash", bash("ls", backend), true],
		["read tool", { ...backend, tool_name: "Read", tool_input: { file_path: "README.md" } }, false],
	]);
});

test("Stop asks for one continuation while a task runs, and never loops", (t) => {
	const root = workspace(t);
	assert.equal(decideStop({ stop_hook_active: false }, { root }), null);
	startTask(root);
	const once = decideStop({ stop_hook_active: false }, { root });
	assert.equal(once.decision, "block");
	assert.match(once.reason, /T1 \(run 20261127T120000Z-abcdef\).*aria run accept.*aria run fail/);
	assert.equal(decideStop({ stop_hook_active: true }, { root }), null);
	assert.equal(decideStop({ stop_hook_active: false, agent_id: "a1" }, { root }), null);
});

test("as a hook: a denial is JSON on stdout, exit 0; Stop and other tools pass through", (t) => {
	const root = workspace(t);
	startTask(root);
	const run = (payload) =>
		spawnSync(process.execPath, [HOOK], {
			input: JSON.stringify({ cwd: root, ...payload }),
			env: { ...process.env, CLAUDE_PROJECT_DIR: root },
			encoding: "utf8",
		});
	const denied = run({ hook_event_name: "PreToolUse", ...write("src/app/x.mjs", backend) });
	assert.equal(denied.status, 0);
	assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
	assert.equal(run({ hook_event_name: "PreToolUse", ...write("src/lib/x.mjs", backend) }).stdout, "");
	assert.equal(JSON.parse(run({ hook_event_name: "Stop", stop_hook_active: false }).stdout).decision, "block");
	// A broken config during a run closes everything, Read included.
	writeFile(root, "aria.config.json", "{");
	const broken = run({ hook_event_name: "PreToolUse", ...write("src/lib/x.mjs", backend) });
	assert.match(JSON.parse(broken.stdout).hookSpecificOutput.permissionDecisionReason, /internal error/);
});
