import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	commandChainDigest,
	compareHandoffToDelta,
	evidenceIsCurrent,
	evidencePassed,
	parseVerificationCommand,
	pathsChangedSince,
	runVerification,
	safeRelative,
	sensitiveChanges,
	sensitiveSnapshot,
	snapshotTree,
	treeDelta,
} from "../lib/run-evidence.mjs";
import { CONFIG, git, workspace, writeFile } from "./helpers/workspace.mjs";

const T1 = { id: "T1", allowed_paths: ["src/lib/**"], requirements: ["R1.1"] };

function deltaAfter(root, change) {
	const before = snapshotTree(root);
	change();
	return treeDelta(root, before, snapshotTree(root));
}

// --- Delta -------------------------------------------------------------------

test("untracked, staged, removed and renamed files all enter the delta", (t) => {
	const root = workspace(t);
	const delta = deltaAfter(root, () => {
		writeFile(root, "src/lib/new.txt", "new\n");
		writeFile(root, "src/lib/staged.txt", "staged\n");
		git(root, ["add", "src/lib/staged.txt"]);
		renameSync(join(root, "src/lib/old.txt"), join(root, "src/lib/renamed.txt"));
		rmSync(join(root, "tools/check.mjs"));
	});
	assert.deepEqual(delta.paths, [
		"src/lib/new.txt",
		"src/lib/old.txt",
		"src/lib/renamed.txt",
		"src/lib/staged.txt",
		"tools/check.mjs",
	]);
	assert.ok(delta.entries.some((e) => e.status === "R" && e.from === "src/lib/old.txt"));
	assert.ok(delta.entries.some((e) => e.status === "D" && e.path === "tools/check.mjs"));
});

test(".git/info/exclude does not hide a changed file", (t) => {
	const root = workspace(t);
	writeFile(root, ".git/info/exclude", "src/lib/hidden.txt\n");
	const delta = deltaAfter(root, () => writeFile(root, "src/lib/hidden.txt", "x\n"));
	assert.deepEqual(delta.paths, ["src/lib/hidden.txt"]);
});

test("ignored and secret files never enter the snapshot tree", (t) => {
	const root = workspace(t);
	const delta = deltaAfter(root, () => {
		writeFile(root, ".env.local", "TOKEN=1\n");
		writeFile(root, "key.pem", "x\n");
		writeFile(root, ".claude/settings.local.json", "{}\n");
		writeFile(root, "node_modules/pkg/index.js", "x\n");
	});
	assert.deepEqual(delta.paths, []);
});

test("snapshotTree does not touch the real index", (t) => {
	const root = workspace(t);
	writeFile(root, "src/lib/new.txt", "new\n");
	snapshotTree(root);
	assert.equal(git(root, ["diff", "--cached", "--name-only"]), "");
});

// --- Handoff against delta ---------------------------------------------------

test("handoff vs delta: omitted, phantom and out-of-territory files", () => {
	const delta = { paths: ["src/lib/a.ts", "src/app/page.tsx"] };
	const findings = compareHandoffToDelta(
		{ changed_files: ["src/lib/a.ts", "src/lib/ghost.ts"] },
		delta,
		T1,
	);
	assert.deepEqual(findings, [
		"changed file missing from the handoff: src/app/page.tsx",
		"handoff declares a file with no real change: src/lib/ghost.ts",
		"change outside the allowed_paths of T1: src/app/page.tsx",
	]);
});

test("a rename out of the territory is rejected even with both sides declared", (t) => {
	const root = workspace(t);
	const delta = deltaAfter(root, () =>
		renameSync(join(root, "src/lib/old.txt"), join(root, "old.txt")),
	);
	const findings = compareHandoffToDelta({ changed_files: delta.paths }, delta, T1);
	assert.deepEqual(findings, ["change outside the allowed_paths of T1: old.txt"]);
});

test("empty allowed_paths rejects any changed file", () => {
	const findings = compareHandoffToDelta(
		{ changed_files: ["src/lib/a.ts"] },
		{ paths: ["src/lib/a.ts"] },
		{ ...T1, allowed_paths: [] },
	);
	assert.deepEqual(findings, ["change outside the allowed_paths of T1: src/lib/a.ts"]);
});

test("requirements: ok needs evidence, and only the task's own count", () => {
	const findings = compareHandoffToDelta(
		{ changed_files: [], requirements: { "R1.1": "ok", "R1.2": "ok" }, evidence: { "R1.2": "e" } },
		{ paths: [] },
		T1,
	);
	assert.deepEqual(findings, [
		"R1.1 = ok without an evidence reference",
		"handoff marks R1.2, which does not belong to T1",
	]);
});

// --- Sensitive set -----------------------------------------------------------

test("local settings, git config, hooks and root secrets are watched by digest", (t) => {
	const root = workspace(t);
	const before = sensitiveSnapshot(root);
	writeFile(root, ".claude/settings.local.json", '{ "permissions": {} }\n');
	git(root, ["config", "core.fsmonitor", "true"]);
	writeFile(root, ".git/hooks/pre-commit", "#!/bin/sh\n");
	writeFile(root, ".env", "SECRET=1\n");
	writeFile(root, "node_modules/pkg/index.js", "x\n");
	assert.deepEqual(sensitiveChanges(before, sensitiveSnapshot(root)), [
		".claude/settings.local.json",
		".env",
		"git-common-dir/config",
		"git-common-dir/hooks",
		"git-dir/config",
		"git-dir/hooks",
		"node_modules",
	]);
	assert.ok(!JSON.stringify(sensitiveSnapshot(root)).includes("SECRET"));
});

test("generated inputs from the config are watched", (t) => {
	const root = workspace(t, {
		config: { ...CONFIG, evidence: { generatedInputs: ["env.d.ts"] } },
	});
	const before = sensitiveSnapshot(root);
	writeFile(root, "env.d.ts", "declare const X: 1;\n");
	assert.deepEqual(sensitiveChanges(before, sensitiveSnapshot(root)), ["env.d.ts"]);
});

test("rewriting a completed dependency's state is part of the sensitive set", (t) => {
	const root = workspace(t);
	const runId = "20261127T000000Z-abcdef";
	writeFile(root, `.aria/runs/${runId}/tasks/T1.json`, '{"state":"completed"}\n');
	writeFile(root, `.aria/runs/${runId}/evidence/T1-0.json`, "{}\n");
	const before = sensitiveSnapshot(root, { runId, dependsOn: ["T1"] });
	writeFile(root, `.aria/runs/${runId}/evidence/T1-0.json`, '{"exit_code":0}\n');
	assert.deepEqual(sensitiveChanges(before, sensitiveSnapshot(root, { runId, dependsOn: ["T1"] })), [
		`.aria/runs/${runId}/evidence/T1-0.json`,
	]);
});

// --- Verification ------------------------------------------------------------

test("verification commands: plain tokens and allowed executables only", () => {
	assert.deepEqual(parseVerificationCommand("npm run test:unit"), ["npm", "run", "test:unit"]);
	assert.throws(() => parseVerificationCommand("npm test; rm -rf /"), /disallowed token/);
	assert.throws(() => parseVerificationCommand("node a.js > out"), /disallowed token/);
	assert.throws(() => parseVerificationCommand("bash -c x"), /executable not allowed/);
});

test("a passing verification records tree, chain digest and exit code, then cleans up", (t) => {
	const root = workspace(t);
	writeFile(root, "src/lib/feature.txt", "ok\n");
	const tree = snapshotTree(root);
	const evidence = runVerification(root, { tree, command: "node tools/check.mjs" });
	assert.equal(evidence.exit_code, 0, evidence.output_tail);
	assert.equal(evidence.error, null);
	assert.equal(evidence.tree, tree);
	assert.match(evidence.chain_digest, /^[0-9a-f]{64}$/);
	assert.ok(evidencePassed(evidence));
	assert.ok(evidenceIsCurrent(evidence, tree));
	assert.deepEqual(readdirSync(join(root, ".aria", "snapshots")), []);
});

test("a failing verification is not evidence, and leaves no snapshot behind", (t) => {
	const root = workspace(t);
	writeFile(root, "src/lib/flag.txt", "FAIL\n");
	const evidence = runVerification(root, { tree: snapshotTree(root), command: "node tools/check.mjs" });
	assert.equal(evidence.exit_code, 1);
	assert.equal(evidencePassed(evidence), false);
	assert.deepEqual(readdirSync(join(root, ".aria", "snapshots")), []);
});

test("evidence for one tree does not hold after the tree changes", (t) => {
	const root = workspace(t);
	const tree = snapshotTree(root);
	const evidence = runVerification(root, { tree, command: "node tools/check.mjs" });
	writeFile(root, "src/lib/later.txt", "x\n");
	assert.equal(evidenceIsCurrent(evidence, snapshotTree(root)), false);
	assert.equal(evidenceIsCurrent({ ...evidence, error: "x" }, tree), false);
	assert.equal(evidencePassed(null), false);
});

test("changing the script the command runs changes the tree and the chain digest", (t) => {
	const root = workspace(t);
	const tree = snapshotTree(root);
	const first = runVerification(root, { tree, command: "node tools/check.mjs" });
	writeFile(root, "tools/check.mjs", "process.exit(0);\n");
	const changedTree = snapshotTree(root);
	const second = runVerification(root, { tree: changedTree, command: "node tools/check.mjs" });
	assert.notEqual(changedTree, tree);
	assert.notEqual(second.chain_digest, first.chain_digest);
});

test("the chain digest follows npm scripts and stays inside the snapshot", (t) => {
	const root = workspace(t);
	writeFile(root, "package.json", JSON.stringify({ scripts: { verify: "npm run inner", inner: "node tools/check.mjs" } }));
	const before = commandChainDigest(root, ["npm", "run", "verify"]);
	writeFile(root, "tools/check.mjs", "// changed\n");
	assert.notEqual(commandChainDigest(root, ["npm", "run", "verify"]), before);
	writeFile(root, "package.json", JSON.stringify({ scripts: { verify: "node ../outside.mjs" } }));
	assert.doesNotThrow(() => commandChainDigest(root, ["npm", "run", "verify"]));
});

test("a verification that writes to the real worktree state is refused", (t) => {
	const root = workspace(t);
	writeFile(root, ".aria/runs/keep.txt", "x\n");
	writeFile(
		root,
		"tools/tamper.mjs",
		'import { writeFileSync } from "node:fs";\nwriteFileSync("../../runs/keep.txt", "tampered");\n',
	);
	const evidence = runVerification(root, { tree: snapshotTree(root), command: "node tools/tamper.mjs" });
	assert.equal(evidence.exit_code, null);
	assert.match(evidence.error, /state changed by the verification: .*\.aria\/runs/);
});

test("git inside the snapshot does not find the real repository", (t) => {
	const root = workspace(t);
	writeFile(
		root,
		"tools/git-probe.mjs",
		'import { spawnSync } from "node:child_process";\nconst r = spawnSync("git", ["rev-parse", "--show-toplevel"]);\nprocess.exit(r.status === 0 ? 1 : 0);\n',
	);
	const evidence = runVerification(root, { tree: snapshotTree(root), command: "node tools/git-probe.mjs" });
	assert.equal(evidence.exit_code, 0, evidence.output_tail);
});

test("node_modules is copied as a real directory and env files stay out", (t) => {
	const root = workspace(t);
	writeFile(root, "node_modules/pkg/index.js", "export default 1;\n");
	writeFile(root, ".env", "SECRET=1\n");
	writeFile(
		root,
		"tools/probe.mjs",
		'import { existsSync, lstatSync } from "node:fs";\nconst ok = lstatSync("node_modules").isDirectory() && existsSync("node_modules/pkg/index.js") && !existsSync(".env");\nprocess.exit(ok ? 0 : 1);\n',
	);
	const evidence = runVerification(root, { tree: snapshotTree(root), command: "node tools/probe.mjs" });
	assert.equal(evidence.exit_code, 0, evidence.output_tail);
});

test("a symlinked .aria fails closed, without falling back to the system tmp dir", (t) => {
	const root = workspace(t);
	const outside = `${root}-outside`;
	mkdirSync(outside);
	t.after(() => rmSync(outside, { recursive: true, force: true }));
	symlinkSync(outside, join(root, ".aria"));
	const evidence = runVerification(root, { tree: snapshotTree(root), command: "node tools/check.mjs" });
	assert.equal(evidence.error, "snapshot_unavailable");
	assert.equal(evidence.exit_code, null);
	assert.deepEqual(readdirSync(outside), []);
});

test("a nonexistent tree leaves no residue", (t) => {
	const root = workspace(t);
	const evidence = runVerification(root, { tree: "0".repeat(40), command: "node tools/check.mjs" });
	assert.equal(evidence.error, "snapshot_unavailable");
	assert.deepEqual(readdirSync(join(root, ".aria", "snapshots")), []);
});

// --- Helpers -----------------------------------------------------------------

test("pathsChangedSince reports only the given paths", (t) => {
	const root = workspace(t);
	const accepted = snapshotTree(root);
	writeFile(root, "src/lib/old.txt", "changed\n");
	writeFile(root, "README.md", "x\n");
	const current = snapshotTree(root);
	assert.deepEqual(pathsChangedSince(root, accepted, current, ["src/lib/old.txt"]), [
		"src/lib/old.txt",
	]);
	assert.deepEqual(pathsChangedSince(root, accepted, current, []), []);
	assert.ok(!existsSync(join(root, ".aria", "snapshots")));
});

test("safeRelative refuses paths outside the root", (t) => {
	const root = workspace(t);
	assert.equal(safeRelative(root, "src/lib/a.ts"), "src/lib/a.ts");
	assert.throws(() => safeRelative(root, "../x"), /outside the root/);
	assert.throws(() => safeRelative(root, "/etc/passwd"), /outside the root/);
});
