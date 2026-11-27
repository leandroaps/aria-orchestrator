// `aria validate contracts`: the generic checks on agent and skill files, the
// project's forbidden claims, and the plugin's own agents and skills.

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { contractFindings, parseFrontmatter } from "../lib/contracts.mjs";
import { normalizeConfig } from "../lib/config.mjs";
import { aria } from "./helpers/run-cli.mjs";
import { CONFIG, workspace, writeFile } from "./helpers/workspace.mjs";

const PLUGIN_ROOT = join(import.meta.dirname, "..");

const skill = (name, description, body = "Body.\n") =>
	`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}`;
const agent = (name, fields, body = "Body.\n", { model = "sonnet", effort = "medium" } = {}) =>
	`---\nname: ${name}\ndescription: Does one thing. Use when asked.\n${model ? `model: ${model}\n` : ""}${effort ? `effort: ${effort}\n` : ""}${fields}---\n\n${body}`;

function findings(root, config = CONFIG, options = {}) {
	return contractFindings(root, normalizeConfig(config), { pluginRoot: PLUGIN_ROOT, ...options });
}

function messages(root, config, options) {
	return findings(root, config, options).map(({ file, line, message }) => `${file}${line ? `:${line}` : ""}: ${message}`);
}

test("frontmatter: scalars, folded text and lists", () => {
	const source = "---\nname: x\ndescription: >\n  one\n  two\ntools: Read, Grep\nskills:\n  - a\n  - b\n---\nbody";
	assert.deepEqual(parseFrontmatter(source), { name: "x", description: "one two", tools: "Read, Grep", skills: ["a", "b"] });
	assert.equal(parseFrontmatter("no frontmatter"), null);
});

test("a clean project has no finding", (t) => {
	const root = workspace(t);
	writeFile(root, ".claude/skills/deploy/SKILL.md", skill("deploy", "Ship a release. Use when the owner asks to deploy."));
	writeFile(root, ".claude/agents/backend.md", agent("backend", "tools: Read, Write, Edit, Bash\nskills:\n  - deploy\n", "Use the `deploy` skill.\n"));
	writeFile(root, ".claude/agents/security.md", agent("security", "tools: Read, Grep, Glob, Bash\n"));
	assert.deepEqual(messages(root), []);
});

test("skill anatomy: name, trigger and length", (t) => {
	const root = workspace(t);
	writeFile(root, ".claude/skills/deploy/SKILL.md", skill("ship", "Ship a release."));
	writeFile(root, ".claude/skills/long/SKILL.md", skill("long", `Use when needed. ${"x".repeat(1100)}`));
	writeFile(root, ".claude/skills/bare/SKILL.md", "# no frontmatter\n");
	assert.deepEqual(messages(root).sort(), [
		".claude/skills/bare/SKILL.md: no frontmatter with name and description",
		".claude/skills/deploy/SKILL.md: description has no trigger (\"Use when …\", \"Use before …\")",
		".claude/skills/deploy/SKILL.md: name \"ship\" differs from the folder \"deploy\"",
		".claude/skills/long/SKILL.md: description has 1117 characters (at most 1024)",
	]);
});

test("agents: name, read-only tools and preloaded skills", (t) => {
	const root = workspace(t);
	writeFile(root, ".claude/agents/backend.md", agent("api", "tools: Read, Write\n", "Use the `deploy` skill first.\n"));
	writeFile(root, ".claude/agents/security.md", agent("security", "tools: Read, Grep, Write\nskills:\n  - ghost\n"));
	assert.deepEqual(messages(root).sort(), [
		'.claude/agents/backend.md: name "api" differs from the file "backend"',
		'.claude/agents/backend.md: says to use the `deploy` skill but does not preload it in `skills`',
		'.claude/agents/security.md: preloads the skill "ghost", which does not exist',
		'.claude/agents/security.md: read-only agent "security" declares tools beyond Read, Grep, Glob, Bash: Write',
	]);
});

test("a read-only agent without a tools list inherits every tool", (t) => {
	const root = workspace(t);
	writeFile(root, ".claude/agents/security.md", agent("security", ""));
	assert.deepEqual(messages(root), [
		'.claude/agents/security.md: read-only agent "security" has no `tools` list, so it inherits every tool',
	]);
});

test("a plugin skill counts as installed, by bare or namespaced name", (t) => {
	const root = workspace(t);
	writeFile(root, ".claude/agents/backend.md", agent("backend", "skills:\n  - spec\n  - aria-orchestrator:debugging\n"));
	assert.deepEqual(messages(root), []);
});

test("project rules: forbidden claims, with the ignore marker", (t) => {
	const root = workspace(t);
	writeFile(root, "CLAUDE.md", "Run the app with the Dockerfile.\n");
	writeFile(root, "AGENTS.md", "<!-- aria-contracts:ignore -->\nExample: `Dockerfile` (illustration)\nA Dockerfile here too. aria-contracts:ignore\n");
	writeFile(root, ".claude/skills/deploy/SKILL.md", skill("deploy", "Use when shipping.", "Build the Dockerfile.\n"));
	const config = { ...CONFIG, contracts: { forbidden: [{ pattern: "\\bDockerfile\\b", reason: "this project has no Docker" }] } };
	assert.deepEqual(messages(root, config).sort(), [
		".claude/skills/deploy/SKILL.md:8: this project has no Docker",
		"CLAUDE.md:1: this project has no Docker",
	]);
});

test("dead paths: a cited path under an existing top-level directory must exist", (t) => {
	const root = workspace(t);
	writeFile(
		root,
		"AGENTS.md",
		[
			"Specs live in `specs/0001-fixture/requirements.md`.",
			"The helper is `src/lib/missing.ts`.",
			"Templates like `specs/<id>/tasks.md` and globs like `src/lib/**` are not paths.",
			"`docs/guide.md` is under a directory that does not exist, so it is not checked.",
		].join("\n"),
	);
	assert.deepEqual(messages(root).sort(), ["AGENTS.md:2: cites `src/lib/missing.ts`, which does not exist"]);
});

test("plugin layout: agents and skills at the root, and fields plugins ignore", (t) => {
	const root = workspace(t);
	writeFile(root, ".claude-plugin/plugin.json", '{ "name": "demo" }\n');
	writeFile(root, "skills/deploy/SKILL.md", skill("deploy", "Use when shipping."));
	writeFile(root, "agents/runner.md", agent("runner", "tools: Bash\npermissionMode: acceptEdits\nhooks: {}\n"));
	assert.deepEqual(messages(root).sort(), [
		"agents/runner.md: `hooks` is ignored for plugin agents",
		"agents/runner.md: `permissionMode` is ignored for plugin agents",
	]);
});

test("the CLI reports findings with exit 1, and the plugin's own files are clean", (t) => {
	const root = workspace(t);
	writeFile(root, ".claude/skills/deploy/SKILL.md", skill("ship", "Use when shipping."));
	const bad = aria(["validate", "contracts", "--json"], { cwd: root, pluginRoot: PLUGIN_ROOT });
	assert.equal(bad.code, 1);
	assert.deepEqual(bad.json().findings, ['.claude/skills/deploy/SKILL.md: name "ship" differs from the folder "deploy"']);

	const own = aria(["validate", "contracts"], { cwd: PLUGIN_ROOT, pluginRoot: PLUGIN_ROOT });
	assert.equal(own.code, 0, own.stdout + own.stderr);
	assert.match(own.stdout, /\d+ files?: 0 findings\./);
});

// The model policy: no agent falls back to the session's model, and the
// plugin's own agents and skills follow the table in lib/model-policy.mjs.
test("an agent without model or effort runs on the session's, which is reported", (t) => {
	const root = workspace(t);
	writeFile(root, ".claude/agents/backend.md", agent("backend", "tools: Read, Write\n", "Body.\n", { model: null, effort: null }));
	writeFile(root, ".claude/agents/frontend.md", agent("frontend", "tools: Read, Write\n", "Body.\n", { effort: null }));
	assert.deepEqual(messages(root).sort(), [
		".claude/agents/backend.md: `effort` is not declared, so the agent runs at the session's effort",
		".claude/agents/backend.md: `model` is not declared, so the agent runs on the session's model",
		".claude/agents/frontend.md: `effort` is not declared, so the agent runs at the session's effort",
	]);
});

test("the plugin's own agents and skills follow the model policy", (t) => {
	const root = workspace(t);
	writeFile(root, ".claude-plugin/plugin.json", '{ "name": "aria-orchestrator" }\n');
	writeFile(root, "agents/controller.md", agent("controller", "tools: Bash, Write\n", "Body.\n", { model: "sonnet", effort: "low" }));
	writeFile(root, "agents/helper.md", agent("helper", "tools: Read\n"));
	writeFile(root, "skills/orchestrate/SKILL.md", `---\nname: orchestrate\neffort: high\ndescription: Use when orchestrating.\n---\n\nBody.\n`);
	writeFile(root, "skills/extra/SKILL.md", `---\nname: extra\neffort: low\ndescription: Use when needed.\n---\n\nBody.\n`);
	writeFile(root, "skills/spec/SKILL.md", `---\nname: spec\ndescription: Use when writing a spec.\n---\n\nBody.\n`);
	assert.deepEqual(messages(root).sort(), [
		'agents/controller.md: model "sonnet" differs from the model policy for controller (haiku)',
		'agents/helper.md: "helper" has no entry in the model policy (lib/model-policy.mjs)',
		'skills/extra/SKILL.md: "extra" has no entry in the model policy (lib/model-policy.mjs)',
		'skills/orchestrate/SKILL.md: effort "high" differs from the model policy for orchestrate (medium)',
		'skills/spec/SKILL.md: effort "(none)" differs from the model policy for spec (high)',
	]);
});
