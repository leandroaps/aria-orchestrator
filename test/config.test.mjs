import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	ConfigError,
	FIXED_EXTERNAL_RESOURCE_PREFIXES,
	externalResourcePattern,
	loadConfig,
	normalizeConfig,
	ownerTerritories,
	ownerVerification,
} from "../lib/config.mjs";
import { CONFIG, workspace } from "./helpers/workspace.mjs";

const withAgents = (agents, extra = {}) => ({ version: 1, agents, ...extra });
const writer = { mode: "write", category: "impl", allowedPaths: ["src/**"], defaultVerification: [] };

test("loadConfig reads aria.config.json and applies defaults", (t) => {
	const root = workspace(t);
	const config = loadConfig(root);
	assert.equal(config.specs.dir, "specs");
	assert.deepEqual(config.evidence.generatedInputs, []);
	assert.deepEqual(config.impactRules, []);
	assert.equal(config.locale, "en");
	assert.deepEqual(ownerTerritories(config).backend, CONFIG.agents.backend.allowedPaths);
	assert.deepEqual(ownerVerification(config).security, []);
});

test("a missing or malformed file is a ConfigError naming the file", (t) => {
	const root = workspace(t);
	writeFileSync(join(root, "aria.config.json"), "{ not json");
	assert.throws(() => loadConfig(root), (error) => {
		assert.ok(error instanceof ConfigError);
		assert.match(error.message, /aria\.config\.json is invalid: not valid JSON/);
		return true;
	});
	rmSync(join(root, "aria.config.json"));
	assert.throws(() => loadConfig(root), /cannot read .*ENOENT; start from templates\/aria\.config\.json/);
});

test("version must be 1", () => {
	assert.throws(() => normalizeConfig({ version: 2, agents: {} }), /version: must be 1 \(found: 2\)/);
});

test("a read-only agent with allowedPaths is rejected", () => {
	const auditor = { ...writer, mode: "read-only" };
	assert.throws(
		() => normalizeConfig(withAgents({ auditor })),
		/agents\.auditor\.allowedPaths: must be empty for a read-only agent/,
	);
});

test("agent entries are type-checked", () => {
	assert.throws(() => normalizeConfig(withAgents({ a: { ...writer, mode: "admin" } })), /mode/);
	assert.throws(() => normalizeConfig(withAgents({ a: { ...writer, category: "" } })), /category/);
	assert.throws(
		() => normalizeConfig(withAgents({ a: { ...writer, allowedPaths: "src/**" } })),
		/allowedPaths/,
	);
	assert.throws(
		() => normalizeConfig(withAgents({ a: { ...writer, defaultVerification: [1] } })),
		/defaultVerification/,
	);
});

test("an impact rule must name a declared agent", () => {
	const rule = { agent: "ghost", requirement: "required", rule: "x", match: ["a/**"] };
	assert.throws(
		() => normalizeConfig(withAgents({ a: writer }, { impactRules: [rule] })),
		/impactRules\[0\]\.agent: must name an agent declared in agents \(a\) \(found: "ghost"\)/,
	);
	const ok = normalizeConfig(withAgents({ a: writer }, { impactRules: [{ ...rule, agent: "a" }] }));
	assert.equal(ok.impactRules.length, 1);
});

test("external resources add to the fixed prefixes and never remove them", () => {
	const config = normalizeConfig(withAgents({}, { run: { externalResources: ["neon", "ci"] } }));
	assert.deepEqual(config.run.externalResources, [...FIXED_EXTERNAL_RESOURCE_PREFIXES, "neon"]);
	const pattern = externalResourcePattern(config);
	assert.ok(pattern.test("neon:test"));
	assert.ok(pattern.test("external:payments"));
	assert.ok(!pattern.test("port:3000"));
	assert.throws(
		() => normalizeConfig(withAgents({}, { run: { externalResources: ["a|b"] } })),
		/run\.externalResources\[0\]: must be a lowercase prefix/,
	);
});

test("paths from config must stay inside the repository", () => {
	assert.throws(
		() => normalizeConfig(withAgents({}, { evidence: { generatedInputs: ["../secret"] } })),
		/generatedInputs/,
	);
	assert.throws(
		() => normalizeConfig(withAgents({}, { evidence: { generatedInputs: ["/etc/passwd"] } })),
		/generatedInputs/,
	);
	assert.throws(() => normalizeConfig(withAgents({}, { specs: { dir: "../specs" } })), /specs\.dir: must be a relative path/);
});

test("locale is en or pt-BR", () => {
	assert.equal(normalizeConfig(withAgents({}, { locale: "pt-BR" })).locale, "pt-BR");
	assert.throws(() => normalizeConfig(withAgents({}, { locale: "fr" })), /locale/);
});

test("every problem is reported at once, each with its location", () => {
	const config = {
		version: 1,
		agents: {
			api: { mode: "admin", category: "", allowedPaths: [], defaultVerification: [] },
			auditor: { mode: "read-only", category: "audit", allowedPaths: ["src/**"], defaultVerification: [] },
		},
		locale: "fr",
	};
	assert.throws(() => normalizeConfig(config), (error) => {
		assert.ok(error instanceof ConfigError);
		assert.deepEqual(error.problems, [
			'agents.api.mode: must be one of read-only, write (found: "admin")',
			'agents.api.category: must be a non-empty string (found: "")',
			"agents.auditor.allowedPaths: must be empty for a read-only agent (found: src/**)",
			'locale: must be one of en, pt-BR (found: "fr")',
		]);
		assert.match(error.message, /^aria\.config\.json has 4 problems:\n {2}- agents\.api\.mode/);
		return true;
	});
});

test("unknown keys are reported, with a suggestion when close to a known one", () => {
	assert.throws(
		() => normalizeConfig({ version: 1, agent: {} }),
		(error) => {
			assert.deepEqual(error.problems, [
				'agent: unknown key (did you mean "agents"?)',
				"agents: must be an object of agents by name (found: undefined)",
			]);
			return true;
		},
	);
	assert.throws(
		() => normalizeConfig(withAgents({ a: { ...writer, allowedPath: [] } }, { specs: { folder: "x" } })),
		(error) => {
			assert.ok(error.problems.includes('agents.a.allowedPath: unknown key (did you mean "allowedPaths"?)'));
			assert.ok(error.problems.includes("specs.folder: unknown key"));
			return true;
		},
	);
	// $schema is allowed, for editor support.
	assert.doesNotThrow(() => normalizeConfig(withAgents({}, { $schema: "./schema.json" })));
});

test("the starter template is valid", () => {
	const template = JSON.parse(readFileSync(new URL("../templates/aria.config.json", import.meta.url)));
	const config = normalizeConfig(template);
	assert.ok(Object.keys(config.agents).length > 0);
	assert.deepEqual(ownerTerritories(config).security, []);
});
