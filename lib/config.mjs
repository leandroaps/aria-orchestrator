// Loader for the consumer repository's `aria.config.json`.
//
// The engine never hard-codes a project's agents, territories, spec folder or
// external resources: every module that needs them receives the object
// returned here. An invalid config fails loudly at load time instead of
// silently further down a run.
//
// This is the minimal loader the engine needs. The JSON Schema and the
// `aria validate config` command build on it.

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const CONFIG_FILE = "aria.config.json";
// Runtime state of a consumer repository (runs, snapshots, handoffs).
export const STATE_DIR = ".aria";

const VALID_MODES = ["read-only", "write"];
const VALID_REQUIREMENTS = ["required", "recommended"];
const VALID_LOCALES = ["en", "pt-BR"];

// Resource prefixes whose exclusivity a local lock cannot prove (another
// clone, host or CI). The project adds its own (`neon`, `cloudflare`, …);
// config can only add to this list, never remove from it.
export const FIXED_EXTERNAL_RESOURCE_PREFIXES = ["external", "ci"];
const RESOURCE_PREFIX_PATTERN = /^[a-z][a-z0-9-]*$/;

// Verification used when a task has none and its owner declares none.
export const FALLBACK_VERIFICATION = ["npm test"];

export class ConfigError extends Error {
	constructor(message) {
		super(`${CONFIG_FILE} is invalid: ${message}`);
		this.name = "ConfigError";
	}
}

function fail(message) {
	throw new ConfigError(message);
}

function isStringArray(value) {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// Relative, inside the repository: no absolute path, no `..` segment.
function isContainedPath(path) {
	return (
		typeof path === "string" &&
		path.length > 0 &&
		!isAbsolute(path) &&
		!path.split(/[\\/]/).includes("..")
	);
}

function validateAgentEntry(name, entry) {
	if (typeof entry !== "object" || entry === null) {
		fail(`"agents.${name}" must be an object`);
	}
	if (!VALID_MODES.includes(entry.mode)) {
		fail(`"agents.${name}.mode" must be one of ${VALID_MODES.join("/")}`);
	}
	if (typeof entry.category !== "string" || entry.category.length === 0) {
		fail(`"agents.${name}.category" must be a non-empty string`);
	}
	if (!isStringArray(entry.allowedPaths)) {
		fail(`"agents.${name}.allowedPaths" must be an array of strings`);
	}
	if (!isStringArray(entry.defaultVerification)) {
		fail(`"agents.${name}.defaultVerification" must be an array of strings`);
	}
	// An auditor does not own territory: a read-only agent with paths is a
	// schema error, not something left for a later check to notice.
	if (entry.mode === "read-only" && entry.allowedPaths.length > 0) {
		fail(
			`"agents.${name}" is read-only but declares allowedPaths (${entry.allowedPaths.join(", ")})`,
		);
	}
}

// An impact rule only yields `required`/`recommended` reviews. The bootstrap
// rule that protects the plugin's own files is fixed in code and never comes
// from here, so a config edit cannot switch it off.
function validateImpactRule(index, rule, agentNames) {
	if (typeof rule !== "object" || rule === null) {
		fail(`"impactRules[${index}]" must be an object`);
	}
	if (typeof rule.agent !== "string" || !agentNames.includes(rule.agent)) {
		fail(
			`"impactRules[${index}].agent" must name an agent declared in "agents" (found: ${JSON.stringify(rule.agent)})`,
		);
	}
	if (!VALID_REQUIREMENTS.includes(rule.requirement)) {
		fail(
			`"impactRules[${index}].requirement" must be one of ${VALID_REQUIREMENTS.join("/")}`,
		);
	}
	if (typeof rule.rule !== "string" || rule.rule.length === 0) {
		fail(`"impactRules[${index}].rule" must be a non-empty string`);
	}
	if (!isStringArray(rule.match)) {
		fail(`"impactRules[${index}].match" must be an array of strings`);
	}
}

function optionalObject(config, key) {
	const value = config[key];
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		fail(`"${key}" must be an object`);
	}
	return value;
}

// Validates a parsed config and returns it with defaults applied. The input
// object is not modified.
export function normalizeConfig(config) {
	if (typeof config !== "object" || config === null || Array.isArray(config)) {
		fail("the root must be an object");
	}
	if (config.version !== 1) {
		fail(`"version" must be 1 (found: ${JSON.stringify(config.version)})`);
	}
	if (typeof config.agents !== "object" || config.agents === null) {
		fail('"agents" must be an object');
	}
	for (const [name, entry] of Object.entries(config.agents)) {
		validateAgentEntry(name, entry);
	}
	const impactRules = config.impactRules ?? [];
	if (!Array.isArray(impactRules)) fail('"impactRules" must be an array');
	const agentNames = Object.keys(config.agents);
	impactRules.forEach((rule, index) => validateImpactRule(index, rule, agentNames));

	const specs = optionalObject(config, "specs");
	const specsDir = specs.dir ?? "specs";
	if (!isContainedPath(specsDir)) {
		fail('"specs.dir" must be a relative path inside the repository');
	}

	const evidence = optionalObject(config, "evidence");
	const generatedInputs = evidence.generatedInputs ?? [];
	if (!isStringArray(generatedInputs) || !generatedInputs.every(isContainedPath)) {
		fail('"evidence.generatedInputs" must be relative paths inside the repository');
	}

	const run = optionalObject(config, "run");
	const extraResources = run.externalResources ?? [];
	if (
		!isStringArray(extraResources) ||
		!extraResources.every((prefix) => RESOURCE_PREFIX_PATTERN.test(prefix))
	) {
		fail('"run.externalResources" must be lowercase resource prefixes, e.g. "neon"');
	}

	const locale = config.locale ?? "en";
	if (!VALID_LOCALES.includes(locale)) {
		fail(`"locale" must be one of ${VALID_LOCALES.join("/")}`);
	}

	return {
		...config,
		impactRules,
		specs: { ...specs, dir: specsDir },
		evidence: { ...evidence, generatedInputs },
		run: {
			...run,
			externalResources: [
				...new Set([...FIXED_EXTERNAL_RESOURCE_PREFIXES, ...extraResources]),
			],
		},
		locale,
	};
}

export function loadConfig(root) {
	const path = join(root, CONFIG_FILE);
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		fail(`cannot read "${path}": ${error.message}`);
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		fail(`"${path}" is not valid JSON: ${error.message}`);
	}
	return normalizeConfig(parsed);
}

export function ownerTerritories(config) {
	return Object.fromEntries(
		Object.entries(config.agents).map(([name, entry]) => [name, entry.allowedPaths]),
	);
}

export function ownerVerification(config) {
	return Object.fromEntries(
		Object.entries(config.agents).map(([name, entry]) => [
			name,
			entry.defaultVerification,
		]),
	);
}

export function externalResourcePattern(config) {
	return new RegExp(`^(${config.run.externalResources.join("|")}):`);
}
