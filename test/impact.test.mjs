import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, normalizeConfig } from "../lib/config.mjs";
import {
	GOVERNANCE_REVIEWER,
	ScopeError,
	changedScope,
	classifyImpact,
	fileMatchesRule,
	isGovernancePath,
} from "../lib/impact.mjs";
import { git, workspace, writeFile } from "./helpers/workspace.mjs";

const writer = { mode: "write", category: "impl", allowedPaths: ["src/**"], defaultVerification: [] };
const auditor = { mode: "read-only", category: "audit", allowedPaths: [], defaultVerification: [] };
const config = normalizeConfig({
	version: 1,
	agents: { api: writer, security: auditor, accessibility: auditor, performance: auditor },
	impactRules: [
		{ agent: "security", requirement: "required", rule: "auth", match: ["src/auth/**"] },
		{ agent: "accessibility", requirement: "recommended", rule: "ui", match: ["src/app/**", "!src/app/api/**"] },
		{ agent: "performance", requirement: "recommended", rule: "lists", match: ["src/*/list.ts"] },
		{ agent: "security", requirement: "recommended", rule: "api", match: ["src/app/api/**"] },
	],
});

test("globs: ** crosses directories, * does not, ! excludes, the rest is literal", () => {
	assert.ok(fileMatchesRule("src/app/a/b/page.tsx", ["src/app/**"]));
	assert.ok(!fileMatchesRule("src/app/api/route.ts", ["src/app/**", "!src/app/api/**"]));
	assert.ok(fileMatchesRule("src/users/list.ts", ["src/*/list.ts"]));
	assert.ok(!fileMatchesRule("src/users/admin/list.ts", ["src/*/list.ts"]));
	assert.ok(!fileMatchesRule("srcXapp/page.tsx", ["src.app/**"]), "a dot is literal");
	assert.ok(!fileMatchesRule("src/app/page.tsx", ["!src/api/**"]), "exclusions alone match nothing");
});

test("governance paths", () => {
	for (const path of [
		"aria.config.json",
		".claude/settings.json",
		".claude/agents/backend.md",
		".claude/skills/plan/SKILL.md",
		"CLAUDE.md",
		"AGENTS.md",
		".github/workflows/ci.yml",
		".github/CODEOWNERS",
		"package.json",
	]) {
		assert.ok(isGovernancePath(path), path);
	}
	for (const path of [".claude/settings.local.json", "docs/CLAUDE.md", "packages/a/package.json", "src/aria.config.json"]) {
		assert.ok(!isGovernancePath(path), path);
	}
});

test("classify: rules, exclusions and required over recommended", () => {
	assert.deepEqual(classifyImpact(["src/app/page.tsx", "src/users/list.ts"], config), {
		required: [],
		recommended: ["accessibility", "performance"],
		undeclared: [],
		reasons: [
			{ agent: "accessibility", rule: "ui", files: ["src/app/page.tsx"] },
			{ agent: "performance", rule: "lists", files: ["src/users/list.ts"] },
		],
	});
	// security is recommended by "api" and required by "auth": required wins.
	const result = classifyImpact(["src/app/api/x.ts", "src/auth/session.ts"], config);
	assert.deepEqual(result.required, ["security"]);
	assert.deepEqual(result.recommended, []);
	assert.equal(classifyImpact([], config).reasons.length, 0);
});

test("classify: governance files always require security, whatever the config says", () => {
	const noRules = normalizeConfig({ version: 1, agents: { security: auditor } });
	const result = classifyImpact(["aria.config.json", "src/x.ts"], noRules);
	assert.deepEqual(result.required, [GOVERNANCE_REVIEWER]);
	assert.deepEqual(result.reasons, [{ agent: "security", rule: "governance", files: ["aria.config.json"] }]);
});

test("classify: manual reviewers only add, and undeclared required reviewers are reported", () => {
	const result = classifyImpact(["src/app/page.tsx"], config, ["accessibility", "sre"]);
	assert.deepEqual(result.required, ["accessibility", "sre"]);
	assert.deepEqual(result.recommended, []);
	assert.deepEqual(result.undeclared, ["sre"]);
	assert.deepEqual(result.reasons[0], { agent: "accessibility", rule: "manual", files: [] });

	const withoutSecurity = normalizeConfig({ version: 1, agents: { api: writer } });
	assert.deepEqual(classifyImpact([".github/workflows/ci.yml"], withoutSecurity).undeclared, ["security"]);
});

test("scope: files since the merge base, specs touched, governance", (t) => {
	const root = workspace(t);
	git(root, ["switch", "-q", "-c", "feature"]);
	writeFile(root, "src/lib/new file.ts", "x\n");
	writeFile(root, "specs/0001-fixture/design.md", "# Design\n\nchanged\n");
	git(root, ["add", "-A"]);
	git(root, ["commit", "-q", "-m", "feature"]);
	// A later commit on main is not part of the feature's change.
	git(root, ["switch", "-q", "main"]);
	writeFile(root, "aria.config.json", `${JSON.stringify(loadConfig(root), null, 2)}\n`);
	git(root, ["commit", "-q", "-am", "main moves"]);

	const scope = changedScope(root, { base: "main", head: "feature" }, loadConfig(root));
	assert.deepEqual(scope.files, ["specs/0001-fixture/design.md", "src/lib/new file.ts"]);
	assert.deepEqual(scope.specs, ["0001"]);
	assert.equal(scope.governanceChanged, false);
	assert.equal(scope.base, git(root, ["merge-base", "main", "feature"]));

	const back = changedScope(root, { base: "feature", head: "main" }, loadConfig(root));
	assert.deepEqual(back.files, ["aria.config.json"]);
	assert.equal(back.governanceChanged, true);
});

test("scope: an unknown ref fails loudly instead of returning no files", (t) => {
	const root = workspace(t);
	assert.throws(
		() => changedScope(root, { base: "nope", head: "HEAD" }, loadConfig(root)),
		(error) => error instanceof ScopeError && /refusing to assume an empty change set/.test(error.message),
	);
	assert.throws(() => changedScope(root, { base: "main" }, loadConfig(root)), /both --base and --head/);
});
