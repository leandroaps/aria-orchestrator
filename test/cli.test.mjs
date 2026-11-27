import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { workspace } from "./helpers/workspace.mjs";

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
	for (const args of [[], ["validate"], ["validate", "spec"], ["validate", "config", "--bogus"]]) {
		const { code, stderr } = aria(args, process.cwd());
		assert.equal(code, 2, args.join(" "));
		assert.match(stderr, /Usage: aria <command>/);
	}
	const help = aria(["--help"], process.cwd());
	assert.equal(help.code, 0);
	assert.match(help.stdout, /validate config/);
});
