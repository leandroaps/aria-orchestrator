import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SPEC, git, workspace, writeFile } from "./helpers/workspace.mjs";

const BIN = fileURLToPath(new URL("../bin/aria.mjs", import.meta.url));

function aria(args, cwd) {
	const result = spawnSync(process.execPath, [BIN, ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, NO_COLOR: "1" },
	});
	return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("validate config: a valid config exits 0 with a one-line summary", (t) => {
	const root = workspace(t);
	const { code, stdout, stderr } = aria(["validate", "config"], root);
	assert.equal(code, 0, stderr);
	assert.equal(
		stdout,
		"aria.config.json is valid: 5 agents (4 write, 1 read-only), 0 impact rules, specs in specs/, locale en.\n",
	);
});

test("validate config: --root points at another directory", (t) => {
	const root = workspace(t);
	const { code } = aria(["validate", "config", "--root", root], process.cwd());
	assert.equal(code, 0);
});

test("validate config: problems go to stderr and exit 1", (t) => {
	const root = workspace(t);
	writeFileSync(join(root, "aria.config.json"), JSON.stringify({ version: 2, agent: {} }));
	const { code, stdout, stderr } = aria(["validate", "config"], root);
	assert.equal(code, 1);
	assert.equal(stdout, "");
	assert.equal(
		stderr,
		[
			"aria.config.json has 3 problems:",
			'  - agent: unknown key (did you mean "agents"?)',
			"  - version: must be 1 (found: 2)",
			"  - agents: must be an object of agents by name (found: undefined)",
			"",
		].join("\n"),
	);
});

test("validate config --json: one JSON object on stdout, no escape codes", (t) => {
	const root = workspace(t);
	let { code, stdout } = aria(["validate", "config", "--json"], root);
	assert.equal(code, 0);
	assert.doesNotMatch(stdout, /\x1b/);
	assert.deepEqual(JSON.parse(stdout), {
		ok: true,
		file: "aria.config.json",
		summary: { agents: 5, writeAgents: 4, readOnlyAgents: 1, impactRules: 0, specsDir: "specs", locale: "en" },
	});

	writeFileSync(join(root, "aria.config.json"), "{");
	({ code, stdout } = aria(["validate", "config", "--json"], root));
	assert.equal(code, 1);
	const result = JSON.parse(stdout);
	assert.equal(result.ok, false);
	assert.match(result.problems[0], /^not valid JSON/);
});

test("validate config: a missing file points at the template", (t) => {
	const root = workspace(t);
	const { code, stderr } = aria(["validate", "config", "--root", join(root, "nowhere")], root);
	assert.equal(code, 1);
	assert.match(stderr, /cannot read .*ENOENT; start from templates\/aria\.config\.json/);
});

test("usage errors exit 2 and print the usage", () => {
	for (const args of [
		[],
		["validate"],
		["validate", "nothing"],
		["validate", "config", "--bogus"],
		["validate", "config", "--base", "main"],
		["validate", "config", "extra"],
		["validate", "graph"],
		["scope", "--base", "main"],
		["classify"],
		["classify", "--files", "x.json", "--base", "main"],
	]) {
		const { code, stderr } = aria(args, process.cwd());
		assert.equal(code, 2, args.join(" "));
		assert.match(stderr, /Usage: aria <command>|Run "aria --help"/);
	}
	const help = aria(["--help"], process.cwd());
	assert.equal(help.code, 0);
	assert.match(help.stdout, /validate config/);
});

test("the root defaults to the git top level of the current directory", (t) => {
	const root = workspace(t);
	mkdirSync(join(root, "src/deep"), { recursive: true });
	const { code, stdout } = aria(["validate", "spec"], join(root, "src/deep"));
	assert.equal(code, 0);
	assert.equal(stdout, "1 spec: 0 findings.\n");
});

test("validate spec and graph: findings exit 1, an unknown spec exits 2", (t) => {
	const root = workspace(t);
	assert.equal(aria(["validate", "graph", "0001"], root).stdout, "0001-fixture, 3 tasks: 0 findings.\n");
	writeFile(root, `specs/${SPEC}/requirements.md`, "**Spec ID:** 0001\n**Status:** Approved\n\n- **R1.1** a\n- **R1.2** b\n- **R1.3** c\n- **R1.4** d\n");
	const { code, stdout } = aria(["validate", "spec", "0001", "--json"], root);
	assert.equal(code, 1);
	assert.deepEqual(JSON.parse(stdout), {
		ok: false,
		specs: [SPEC],
		findings: [`${SPEC}: R1.4 has no task and no manual/external verification entry`],
		info: [],
	});
	const unknown = aria(["validate", "graph", "0999"], root);
	assert.equal(unknown.code, 2);
	assert.match(unknown.stderr, /no spec matches "0999" in specs\//);
});

test("validate handoff: --base compares the handoff with the real change", (t) => {
	const root = workspace(t);
	const handoff = {
		agent: "backend",
		task: "T1",
		status: "completed",
		requirements: { "R1.1": "ok" },
		evidence: { "R1.1": "node tools/check.mjs" },
		changed_files: ["src/lib/new.ts"],
		verification: [],
		findings: [],
		blocked_by: [],
		next: [],
	};
	writeFile(root, "handoff.json", JSON.stringify(handoff));
	writeFile(root, ".gitignore", ".aria/\nnode_modules/\nhandoff.json\n");
	git(root, ["commit", "-q", "-am", "ignore the handoff"]);
	assert.equal(aria(["validate", "handoff", "0001", "handoff.json"], root).code, 0);

	writeFile(root, "src/lib/new.ts", "x\n");
	writeFile(root, "src/app/stray.ts", "x\n");
	const { code, stdout } = aria(["validate", "handoff", "0001", "handoff.json", "--base", "HEAD", "--json"], root);
	assert.equal(code, 1);
	assert.deepEqual(JSON.parse(stdout).findings, [
		"changed file missing from the handoff: src/app/stray.ts",
		"change outside the allowed_paths of T1: src/app/stray.ts",
	]);
	assert.equal(aria(["validate", "handoff", "0001", "missing.json"], root).code, 2);
	assert.equal(aria(["validate", "handoff", "0001", "handoff.json", "--base", "nope"], root).code, 2);
});

test("validate run: no runs is fine, a bad run id is a finding", (t) => {
	const root = workspace(t);
	assert.equal(aria(["validate", "run"], root).stdout, "0 runs: 0 findings.\n");
	const { code, stdout } = aria(["validate", "run", "x"], root);
	assert.equal(code, 1);
	assert.match(stdout, /x: "x" is not a run id/);
});

test("scope and classify", (t) => {
	const root = workspace(t);
	git(root, ["switch", "-q", "-c", "feature"]);
	writeFile(root, ".github/workflows/ci.yml", "on: push\n");
	git(root, ["add", "-A"]);
	git(root, ["commit", "-q", "-m", "ci"]);

	const scope = aria(["scope", "--base", "main", "--head", "feature", "--json"], root);
	assert.equal(scope.code, 0);
	assert.deepEqual(JSON.parse(scope.stdout).files, [".github/workflows/ci.yml"]);

	const classify = aria(["classify", "--base", "main", "--head", "feature"], root);
	assert.equal(classify.code, 0);
	assert.equal(classify.stdout, "  security (governance): .github/workflows/ci.yml\nrequired: security; recommended: none.\n");

	writeFile(root, "files.json", JSON.stringify(["src/app/page.tsx"]));
	writeFile(root, "manual.json", JSON.stringify({ required: ["sre"] }));
	const manual = aria(["classify", "--files", "files.json", "--manual", "manual.json", "--json"], root);
	assert.equal(manual.code, 1, "sre is required but not declared");
	assert.deepEqual(JSON.parse(manual.stdout).undeclared, ["sre"]);

	const badRef = aria(["scope", "--base", "nope", "--head", "HEAD", "--json"], root);
	assert.equal(badRef.code, 1);
	assert.match(JSON.parse(badRef.stdout).problems[0], /refusing to assume an empty change set/);
});
