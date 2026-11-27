// Loader for the consumer repository's `aria.config.json`.
//
// The engine never hard-codes a project's agents, territories, spec folder or
// external resources: every module that needs them receives the object
// returned here. An invalid config fails loudly at load time instead of
// silently further down a run.
//
// schema/aria.config.schema.json describes the same rules for editors; the
// tests keep the two in step. `aria validate config` runs this loader.

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const CONFIG_FILE = "aria.config.json";
// Runtime state of a consumer repository (runs, snapshots, handoffs).
export const STATE_DIR = ".aria";

export const VALID_MODES = ["read-only", "write"];
export const VALID_REQUIREMENTS = ["required", "recommended"];
export const VALID_LOCALES = ["en", "pt-BR"];

// Resource prefixes whose exclusivity a local lock cannot prove (another
// clone, host or CI). The project adds its own (`neon`, `cloudflare`, …);
// config can only add to this list, never remove from it.
export const FIXED_EXTERNAL_RESOURCE_PREFIXES = ["external", "ci"];
const RESOURCE_PREFIX_PATTERN = /^[a-z][a-z0-9-]*$/;

// Verification used when a task has none and its owner declares none.
export const FALLBACK_VERIFICATION = ["npm test"];

// Each problem names where it is (`agents.api.mode`) and what was expected.
// A load reports every problem at once, so one edit can fix them all.
export class ConfigError extends Error {
	constructor(problems, file = CONFIG_FILE) {
		const message =
			problems.length === 1
				? `${file} is invalid: ${problems[0]}`
				: `${file} has ${problems.length} problems:\n${problems.map((p) => `  - ${p}`).join("\n")}`;
		super(message);
		this.name = "ConfigError";
		this.problems = problems;
	}
}

// Keys each object accepts. Anything else is reported, usually a typo.
export const KNOWN_KEYS = {
	root: ["$schema", "version", "agents", "impactRules", "specs", "evidence", "run", "contracts", "locale"],
	agent: ["mode", "category", "allowedPaths", "defaultVerification"],
	impactRule: ["agent", "requirement", "rule", "match"],
	specs: ["dir"],
	evidence: ["generatedInputs"],
	run: ["externalResources"],
	contracts: ["forbidden"],
	forbiddenClaim: ["pattern", "reason"],
};

const found = (value) => `(found: ${JSON.stringify(value)})`;
const oneOf = (values) => values.join(", ");

function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
		!/^[A-Za-z]:/.test(path) &&
		!path.split(/[\\/]/).includes("..")
	);
}

// Levenshtein distance, for "did you mean" on unknown keys.
function distance(a, b) {
	let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i += 1) {
		const current = [i];
		for (let j = 1; j <= b.length; j += 1) {
			current[j] = Math.min(
				previous[j] + 1,
				current[j - 1] + 1,
				previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
		previous = current;
	}
	return previous[b.length];
}

function unknownKeys(problems, where, object, known) {
	for (const key of Object.keys(object)) {
		if (known.includes(key)) continue;
		const close = known.find(
			(candidate) =>
				distance(key.toLowerCase(), candidate.toLowerCase()) <= Math.max(1, Math.floor(candidate.length / 4)),
		);
		const at = where ? `${where}.${key}` : key;
		problems.push(`${at}: unknown key${close ? ` (did you mean "${close}"?)` : ""}`);
	}
}

function checkAgent(problems, name, entry) {
	const at = `agents.${name}`;
	if (!isObject(entry)) {
		problems.push(`${at}: must be an object`);
		return;
	}
	unknownKeys(problems, at, entry, KNOWN_KEYS.agent);
	if (!VALID_MODES.includes(entry.mode)) {
		problems.push(`${at}.mode: must be one of ${oneOf(VALID_MODES)} ${found(entry.mode)}`);
	}
	if (typeof entry.category !== "string" || entry.category.length === 0) {
		problems.push(`${at}.category: must be a non-empty string ${found(entry.category)}`);
	}
	if (!isStringArray(entry.allowedPaths)) {
		problems.push(`${at}.allowedPaths: must be an array of strings ${found(entry.allowedPaths)}`);
	} else if (entry.mode === "read-only" && entry.allowedPaths.length > 0) {
		// An auditor does not own territory: a read-only agent with paths is
		// a config error, not something left for a later check to notice.
		problems.push(
			`${at}.allowedPaths: must be empty for a read-only agent (found: ${entry.allowedPaths.join(", ")})`,
		);
	}
	if (!isStringArray(entry.defaultVerification)) {
		problems.push(
			`${at}.defaultVerification: must be an array of strings ${found(entry.defaultVerification)}`,
		);
	}
}

// An impact rule only yields `required`/`recommended` reviews. The bootstrap
// rule that protects the plugin's own files is fixed in code and never comes
// from here, so a config edit cannot switch it off.
function checkImpactRule(problems, index, rule, agentNames) {
	const at = `impactRules[${index}]`;
	if (!isObject(rule)) {
		problems.push(`${at}: must be an object`);
		return;
	}
	unknownKeys(problems, at, rule, KNOWN_KEYS.impactRule);
	if (typeof rule.agent !== "string" || !agentNames.includes(rule.agent)) {
		const declared = agentNames.length > 0 ? oneOf(agentNames) : "none declared";
		problems.push(`${at}.agent: must name an agent declared in agents (${declared}) ${found(rule.agent)}`);
	}
	if (!VALID_REQUIREMENTS.includes(rule.requirement)) {
		problems.push(
			`${at}.requirement: must be one of ${oneOf(VALID_REQUIREMENTS)} ${found(rule.requirement)}`,
		);
	}
	if (typeof rule.rule !== "string" || rule.rule.length === 0) {
		problems.push(`${at}.rule: must be a non-empty string ${found(rule.rule)}`);
	}
	if (!isStringArray(rule.match)) {
		problems.push(`${at}.match: must be an array of strings ${found(rule.match)}`);
	}
}

// A project rule for `aria validate contracts`: a pattern that must compile
// and the reason shown with each match.
function checkForbiddenClaim(problems, index, claim) {
	const at = `contracts.forbidden[${index}]`;
	if (!isObject(claim)) {
		problems.push(`${at}: must be an object`);
		return;
	}
	unknownKeys(problems, at, claim, KNOWN_KEYS.forbiddenClaim);
	if (typeof claim.pattern !== "string" || claim.pattern.length === 0) {
		problems.push(`${at}.pattern: must be a non-empty string ${found(claim.pattern)}`);
	} else {
		try {
			new RegExp(claim.pattern, "u");
		} catch (error) {
			problems.push(`${at}.pattern: not a valid regular expression (${error.message})`);
		}
	}
	if (typeof claim.reason !== "string" || claim.reason.length === 0) {
		problems.push(`${at}.reason: must be a non-empty string ${found(claim.reason)}`);
	}
}

// Optional section: absent is `{}`; present must be an object with known keys.
function section(problems, config, key) {
	const value = config[key];
	if (value === undefined) return {};
	if (!isObject(value)) {
		problems.push(`${key}: must be an object ${found(value)}`);
		return {};
	}
	unknownKeys(problems, key, value, KNOWN_KEYS[key]);
	return value;
}

// Validates a parsed config and returns it with defaults applied. Throws a
// ConfigError listing every problem. The input object is not modified.
export function normalizeConfig(config, file = CONFIG_FILE) {
	if (!isObject(config)) {
		throw new ConfigError([`the root must be a JSON object ${found(config)}`], file);
	}
	const problems = [];
	unknownKeys(problems, "", config, KNOWN_KEYS.root);
	if (config.version !== 1) {
		problems.push(`version: must be 1 ${found(config.version)}`);
	}

	const agents = isObject(config.agents) ? config.agents : {};
	if (!isObject(config.agents)) {
		problems.push(`agents: must be an object of agents by name ${found(config.agents)}`);
	}
	for (const [name, entry] of Object.entries(agents)) checkAgent(problems, name, entry);

	let impactRules = config.impactRules ?? [];
	if (!Array.isArray(impactRules)) {
		problems.push(`impactRules: must be an array ${found(impactRules)}`);
		impactRules = [];
	}
	const agentNames = Object.keys(agents);
	impactRules.forEach((rule, index) => checkImpactRule(problems, index, rule, agentNames));

	const specs = section(problems, config, "specs");
	const specsDir = specs.dir ?? "specs";
	if (!isContainedPath(specsDir)) {
		problems.push(`specs.dir: must be a relative path inside the repository ${found(specsDir)}`);
	}

	const evidence = section(problems, config, "evidence");
	const generatedInputs = evidence.generatedInputs ?? [];
	if (!isStringArray(generatedInputs)) {
		problems.push(`evidence.generatedInputs: must be an array of strings ${found(generatedInputs)}`);
	} else {
		generatedInputs.forEach((path, index) => {
			if (!isContainedPath(path)) {
				problems.push(
					`evidence.generatedInputs[${index}]: must be a relative path inside the repository ${found(path)}`,
				);
			}
		});
	}

	const run = section(problems, config, "run");
	const extraResources = run.externalResources ?? [];
	if (!isStringArray(extraResources)) {
		problems.push(`run.externalResources: must be an array of strings ${found(extraResources)}`);
	} else {
		extraResources.forEach((prefix, index) => {
			if (!RESOURCE_PREFIX_PATTERN.test(prefix)) {
				problems.push(
					`run.externalResources[${index}]: must be a lowercase prefix such as "neon" ${found(prefix)}`,
				);
			}
		});
	}

	const contracts = section(problems, config, "contracts");
	let forbidden = contracts.forbidden ?? [];
	if (!Array.isArray(forbidden)) {
		problems.push(`contracts.forbidden: must be an array ${found(forbidden)}`);
		forbidden = [];
	}
	forbidden.forEach((claim, index) => checkForbiddenClaim(problems, index, claim));

	const locale = config.locale ?? "en";
	if (!VALID_LOCALES.includes(locale)) {
		problems.push(`locale: must be one of ${oneOf(VALID_LOCALES)} ${found(locale)}`);
	}

	if (problems.length > 0) throw new ConfigError(problems, file);

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
		contracts: { ...contracts, forbidden },
		locale,
	};
}

export function loadConfig(root) {
	const path = join(root, CONFIG_FILE);
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		const hint = error.code === "ENOENT" ? "; start from templates/aria.config.json" : "";
		throw new ConfigError([`cannot read ${path}: ${error.code ?? error.message}${hint}`]);
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new ConfigError([`not valid JSON: ${error.message}`]);
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
