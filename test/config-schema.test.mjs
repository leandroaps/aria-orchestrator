import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	ConfigError,
	KNOWN_KEYS,
	VALID_LOCALES,
	VALID_MODES,
	VALID_REQUIREMENTS,
	normalizeConfig,
} from "../lib/config.mjs";
import { CONFIG } from "./helpers/workspace.mjs";

// The loader (lib/config.mjs) is what ARIA runs; the schema is what editors
// read. These tests keep them in step: same keys, same enums, and the same
// verdict on a corpus of valid and invalid configs.

const readJson = (relative) => JSON.parse(readFileSync(new URL(`../${relative}`, import.meta.url)));
const schema = readJson("schema/aria.config.schema.json");
const template = readJson("templates/aria.config.json");

// The subset of JSON Schema 2020-12 the ARIA schema uses. A keyword outside
// it fails the test, so the schema cannot grow past what is checked here.
const SUPPORTED = new Set([
	"$schema", "$id", "$defs", "$ref", "title", "description", "default",
	"type", "const", "enum", "required", "properties", "additionalProperties",
	"items", "minLength", "maxItems", "pattern", "not", "if", "then",
]);

function typeOf(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function valid(node, value) {
	for (const keyword of Object.keys(node)) {
		assert.ok(SUPPORTED.has(keyword), `schema keyword "${keyword}" is not supported by this test`);
	}
	if (node.$ref) return valid(schema.$defs[node.$ref.replace("#/$defs/", "")], value);
	if (node.type && typeOf(value) !== node.type) return false;
	if ("const" in node && value !== node.const) return false;
	if (node.enum && !node.enum.includes(value)) return false;
	if (node.minLength !== undefined && value.length < node.minLength) return false;
	if (node.maxItems !== undefined && value.length > node.maxItems) return false;
	if (node.pattern && !new RegExp(node.pattern, "u").test(value)) return false;
	if (node.not && valid(node.not, value)) return false;
	if (node.if && valid(node.if, value) && !valid(node.then, value)) return false;
	if (node.items && !value.every((item) => valid(node.items, item))) return false;
	if (typeOf(value) === "object") {
		if (node.required && !node.required.every((key) => key in value)) return false;
		for (const [key, item] of Object.entries(value)) {
			const property = node.properties?.[key];
			if (property) {
				if (!valid(property, item)) return false;
			} else if (node.additionalProperties === false) {
				return false;
			} else if (typeof node.additionalProperties === "object" && !valid(node.additionalProperties, item)) {
				return false;
			}
		}
	}
	return true;
}

function loaderAccepts(config) {
	try {
		normalizeConfig(config);
		return true;
	} catch (error) {
		if (error instanceof ConfigError) return false;
		throw error;
	}
}

const writer = { mode: "write", category: "impl", allowedPaths: ["src/**"], defaultVerification: ["npm test"] };
const auditor = { mode: "read-only", category: "audit", allowedPaths: [], defaultVerification: [] };
const base = { version: 1, agents: { api: writer, security: auditor } };
const rule = { agent: "security", requirement: "required", rule: "auth", match: ["src/auth/**"] };
const withKey = (extra) => ({ ...base, ...extra });
const withAgent = (patch) => withKey({ agents: { api: { ...writer, ...patch } } });

const VALID = {
	"minimal": base,
	"no agents": { version: 1, agents: {} },
	"template": template,
	"test fixture": CONFIG,
	"all sections": withKey({
		$schema: "./x.json",
		impactRules: [rule],
		specs: { dir: "docs/specs" },
		evidence: { generatedInputs: ["src/generated/types.ts"] },
		run: { externalResources: ["neon", "cloudflare-d1"] },
		locale: "pt-BR",
	}),
};

const INVALID = {
	"root is an array": [],
	"version 2": withKey({ version: 2 }),
	"version missing": { agents: {} },
	"agents missing": { version: 1 },
	"unknown root key": withKey({ agent: {} }),
	"mode admin": withAgent({ mode: "admin" }),
	"empty category": withAgent({ category: "" }),
	"allowedPaths a string": withAgent({ allowedPaths: "src/**" }),
	"verification not strings": withAgent({ defaultVerification: [1] }),
	"agent key missing": withKey({ agents: { api: { mode: "write", category: "x", allowedPaths: [] } } }),
	"unknown agent key": withAgent({ owner: "me" }),
	"read-only with paths": withKey({ agents: { security: { ...auditor, allowedPaths: ["src/**"] } } }),
	"impactRules not an array": withKey({ impactRules: {} }),
	"bad requirement": withKey({ impactRules: [{ ...rule, requirement: "optional" }] }),
	"empty rule name": withKey({ impactRules: [{ ...rule, rule: "" }] }),
	"unknown rule key": withKey({ impactRules: [{ ...rule, why: "x" }] }),
	"specs.dir with ..": withKey({ specs: { dir: "../specs" } }),
	"specs.dir absolute": withKey({ specs: { dir: "/specs" } }),
	"specs.dir on a Windows drive": withKey({ specs: { dir: "C:\\specs" } }),
	"specs.dir empty": withKey({ specs: { dir: "" } }),
	"unknown specs key": withKey({ specs: { folder: "x" } }),
	"generated input escapes": withKey({ evidence: { generatedInputs: ["a/../../etc"] } }),
	"resource with a pipe": withKey({ run: { externalResources: ["a|b"] } }),
	"resource in capitals": withKey({ run: { externalResources: ["Neon"] } }),
	"locale fr": withKey({ locale: "fr" }),
	"section not an object": withKey({ run: [] }),
};

// Rules the schema cannot express; only the loader checks them.
const LOADER_ONLY = {
	"impact rule names an undeclared agent": withKey({ impactRules: [{ ...rule, agent: "ghost" }] }),
};

for (const [name, config] of Object.entries(VALID)) {
	test(`schema and loader both accept: ${name}`, () => {
		assert.equal(valid(schema, config), true, "schema");
		assert.equal(loaderAccepts(config), true, "loader");
	});
}

for (const [name, config] of Object.entries(INVALID)) {
	test(`schema and loader both reject: ${name}`, () => {
		assert.equal(valid(schema, config), false, "schema");
		assert.equal(loaderAccepts(config), false, "loader");
	});
}

test("rules only the loader can check are documented in the schema", () => {
	for (const config of Object.values(LOADER_ONLY)) {
		assert.equal(valid(schema, config), true);
		assert.equal(loaderAccepts(config), false);
	}
	assert.match(schema.description, /impact rule must name an agent declared/);
});

test("schema and loader declare the same keys and enums", () => {
	const keys = (node) => Object.keys(node.properties).sort();
	assert.deepEqual(keys(schema), [...KNOWN_KEYS.root].sort());
	assert.deepEqual(keys(schema.$defs.agent), [...KNOWN_KEYS.agent].sort());
	assert.deepEqual(keys(schema.$defs.impactRule), [...KNOWN_KEYS.impactRule].sort());
	for (const section of ["specs", "evidence", "run"]) {
		assert.deepEqual(keys(schema.properties[section]), [...KNOWN_KEYS[section]].sort());
	}
	assert.deepEqual(schema.$defs.agent.properties.mode.enum, VALID_MODES);
	assert.deepEqual(schema.$defs.impactRule.properties.requirement.enum, VALID_REQUIREMENTS);
	assert.deepEqual(schema.properties.locale.enum, VALID_LOCALES);
});

test("defaults in the schema are the loader's defaults", () => {
	const config = normalizeConfig({ version: 1, agents: {} });
	assert.equal(config.specs.dir, schema.properties.specs.properties.dir.default);
	assert.equal(config.locale, schema.properties.locale.default);
	assert.deepEqual(config.impactRules, schema.properties.impactRules.default);
	assert.deepEqual(config.evidence.generatedInputs, schema.properties.evidence.properties.generatedInputs.default);
});

test("the template points editors at the schema in this repository", () => {
	assert.equal(
		template.$schema,
		"https://raw.githubusercontent.com/leandroaps/aria-orchestrator/main/schema/aria.config.schema.json",
	);
});
