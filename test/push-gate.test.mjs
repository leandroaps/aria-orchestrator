// The push gate: before `git push` of a branch, the governance checks run in
// the pushed worktree (`aria gate` runs them by hand). Ported from
// bernardo-pet `scripts/agent-push-gate.mjs`; the checks are aria's own.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gate, manualGate, readCommand } from "../lib/push-gate.mjs";
import { aria } from "./helpers/run-cli.mjs";
import { CONFIG, SPEC, git, workspace, writeFile } from "./helpers/workspace.mjs";

const HOOK = fileURLToPath(new URL("../hooks/push-gate.mjs", import.meta.url));

// A workspace on branch `feature/x`, with `origin/HEAD` pointing at `main`.
function repo(t, options) {
	const root = workspace(t, options);
	git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
	git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
	git(root, ["checkout", "-q", "-b", "feature/x"]);
	return root;
}

function commit(root, path, content) {
	writeFile(root, path, content);
	git(root, ["add", "-A"]);
	git(root, ["commit", "-q", "-m", `change ${path}`]);
}

const push = (root, command, cwd = root) => gate({ command, cwd, projectDir: root });

// --- Reading the command (no repository needed) --------------------------------

test("commands that are not a branch push pass without reading anything", () => {
	for (const command of [
		"git status && ls",
		"git log --grep push",
		"git push origin --delete feature/x",
		"git push origin :feature/x",
		"git push --tags",
		'git commit -m "fix git push gate"',
		'gh pr create --body "run git push"',
	]) {
		assert.deepEqual(readCommand(command, "/r"), { pushes: [] }, command);
	}
});

test("the push directory comes from -C and cd, relative to the last cd", () => {
	assert.equal(readCommand("git push", "/r").pushes[0].dir, "/r");
	assert.equal(readCommand("git -C /a push", "/r").pushes[0].dir, "/a");
	assert.equal(readCommand("cd /a && git push", "/r").pushes[0].dir, "/a");
	assert.equal(readCommand("cd /a/sub && git -C .. push", "/r").pushes[0].dir, "/a");
	assert.equal(readCommand("git -c color.ui=never push origin HEAD", "/r").pushes.length, 1);
	assert.equal(readCommand("git push origin HEAD 2>&1", "/r").pushes.length, 1);
	assert.equal(readCommand("\\git push origin HEAD", "/r").pushes.length, 1);
});

test("a push directory the text cannot resolve is refused", () => {
	for (const command of [
		'cd "$W" && git push',
		"cd $(pwd) && git push",
		"cd `pwd` && git push",
		"cd ~ && git push",
		"pushd x && git push",
		"(cd /a && git push)",
		"git --git-dir=x push",
		"git --work-tree=x push",
		"GIT_DIR=x git push",
		"GIT_WORK_TREE=x git push",
		"git -C a -C b push",
	]) {
		assert.match(readCommand(command, "/r").error ?? "", /git -C <absolute path>/, command);
	}
	assert.match(readCommand("git push --all", "/r").error, /--all/);
});

test("a push hidden in another command or an alias is refused", () => {
	for (const command of [
		"sh -c 'git push origin HEAD'",
		'bash -c "git push"',
		"eval git push",
		"xargs git push",
		"timeout 60 git push",
		"nice git push",
		"git -c alias.p=push p origin HEAD",
		"git -c Alias.p=push p origin HEAD",
		"git --config-env=alias.p=V p origin HEAD",
		"GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p",
		"echo $(git push origin other)",
		"true `git push origin other`",
		"cat <(git push)",
	]) {
		assert.match(readCommand(command, "/r").error ?? "", /wrapped|alias/, command);
	}
	// A lone `&` separates commands too.
	assert.equal(readCommand("true & git push origin HEAD", "/r").pushes.length, 1);
});

// --- Checks on a real worktree ---------------------------------------------------

test("a clean branch with valid specs passes, after every check ran", async (t) => {
	const root = repo(t);
	commit(root, "src/lib/new.txt", "new\n");
	const result = await push(root, "git push -u origin HEAD");
	assert.equal(result.allow, true, result.message);
	assert.deepEqual(result.checks, ["validate config", "classify"]);
	const named = await push(root, "git push origin feature/x");
	assert.equal(named.allow, true, named.message);
});

test("a changed spec is validated, with its graph, and a finding blocks the push", async (t) => {
	const root = repo(t);
	commit(root, `specs/${SPEC}/design.md`, "# Design\n\nMore.\n");
	const green = await push(root, "git push");
	assert.deepEqual(green.checks, ["validate config", `validate spec ${SPEC}`, `validate graph ${SPEC}`, "classify"]);
	commit(root, `specs/${SPEC}/requirements.md`, "# Requirements\n\n**Spec ID:** 0001\n**Status:** Approved\n");
	const red = await push(root, "git push");
	assert.equal(red.allow, false);
	assert.match(red.message, new RegExp(`^validate spec ${SPEC} failed`));
	assert.match(red.message, new RegExp(`reproduce: aria validate spec ${SPEC}`));
});

test("a governance change needs a declared security reviewer", async (t) => {
	const agents = Object.fromEntries(Object.entries(CONFIG.agents).filter(([name]) => name !== "security"));
	const root = repo(t, { config: { ...CONFIG, agents } });
	commit(root, "package.json", "{}\n");
	const result = await push(root, "git push");
	assert.equal(result.allow, false);
	assert.match(result.message, /^classify failed/);
	assert.match(result.message, /security/);
});

test("only the current branch is pushed", async (t) => {
	const root = repo(t);
	for (const command of ["git push origin other", "git push origin HEAD~1:refs/heads/x"]) {
		const result = await push(root, command);
		assert.equal(result.allow, false, command);
		assert.match(result.message, /refspec/);
	}
});

test("the tree pushed must be the tree checked", async (t) => {
	const root = repo(t);
	writeFile(root, "src/lib/old.txt", "dirty\n");
	assert.match((await push(root, "git push")).message, /commit or stash/);
	git(root, ["checkout", "--", "src/lib/old.txt"]);
	git(root, ["update-index", "--skip-worktree", "src/lib/old.txt"]);
	assert.match((await push(root, "git push")).message, /cannot be checked/);
	git(root, ["update-index", "--no-skip-worktree", "src/lib/old.txt"]);
	git(root, ["update-index", "--assume-unchanged", "src/lib/old.txt"]);
	assert.match((await push(root, "git push")).message, /cannot be checked/);
});

test("the push must come from a registered worktree root of the project", async (t) => {
	const root = repo(t);
	const stranger = repo(t);
	mkdirSync(join(root, "sub"));
	assert.match((await push(root, `git -C ${stranger} push`)).message, /registered worktree/);
	assert.match((await push(root, `git -C ${join(root, "sub")} push`)).message, /registered worktree/);
	assert.match((await push(root, "git -C /does/not/exist push")).message, /git -C <absolute path>/);
	assert.match((await gate({ command: "git push", cwd: root })).message, /CLAUDE_PROJECT_DIR/);
});

test("without a default branch to compare with, it says how to fetch one", async (t) => {
	const root = repo(t);
	git(root, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
	git(root, ["update-ref", "-d", "refs/remotes/origin/main"]);
	assert.match((await push(root, "git push")).message, /git remote set-head origin --auto/);
});

// --- The hook and `aria gate` -------------------------------------------------------

test("as a hook: exit 2 with the reason on stderr; other tools and commands pass", (t) => {
	const root = repo(t);
	const run = (payload) =>
		spawnSync(process.execPath, [HOOK], {
			input: JSON.stringify(payload),
			env: { ...process.env, CLAUDE_PROJECT_DIR: root },
			encoding: "utf8",
		});
	const bash = (command) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: root });
	assert.equal(run(bash("ls")).status, 0);
	assert.equal(run({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} }).status, 0);
	assert.equal(run(bash("git push origin HEAD")).status, 0);
	const denied = run(bash("git push origin other"));
	assert.equal(denied.status, 2);
	assert.match(denied.stderr, /^\[aria push-gate\] refspec/);
});

test("aria gate: the same checks by hand, from any subdirectory", async (t) => {
	const root = repo(t);
	mkdirSync(join(root, "src", "deep"), { recursive: true });
	const green = await manualGate({ cwd: realpathSync(join(root, "src")) });
	assert.equal(green.allow, true, green.message);
	const ok = aria(["gate"], { cwd: root });
	assert.equal(ok.code, 0, ok.stderr);
	assert.match(ok.stdout, /^gate: 2 checks passed\.$/m);
	commit(root, `specs/${SPEC}/requirements.md`, "# Requirements\n\n**Spec ID:** 0001\n**Status:** Approved\n");
	const red = aria(["gate", "--json"], { cwd: root });
	assert.equal(red.code, 1);
	assert.equal(red.json().allow, false);
	assert.match(red.json().message, /validate spec/);
});
