import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
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
		assert.match(error.message, /aria\.config\.json.*not valid JSON/);
		return true;
	});
	rmSync(join(root, "aria.config.json"));
	assert.throws(() => loadConfig(root), /cannot read/);
});

test("version must be 1", () => {
	assert.throws(() => normalizeConfig({ version: 2, agents: {} }), /"version" must be 1/);
});

test("a read-only agent with allowedPaths is rejected", () => {
	const auditor = { ...writer, mode: "read-only" };
	assert.throws(
		() => normalizeConfig(withAgents({ auditor })),
		/"agents\.auditor" is read-only but declares allowedPaths/,
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
		/impactRules\[0\]\.agent/,
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
		/run\.externalResources/,
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
	assert.throws(() => normalizeConfig(withAgents({}, { specs: { dir: "../specs" } })), /specs\.dir/);
});

test("locale is en or pt-BR", () => {
	assert.equal(normalizeConfig(withAgents({}, { locale: "pt-BR" })).locale, "pt-BR");
	assert.throws(() => normalizeConfig(withAgents({}, { locale: "fr" })), /locale/);
});
