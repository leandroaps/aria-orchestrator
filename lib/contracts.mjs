// `aria validate contracts`: checks on the files that instruct the agents.
// Read-only: it reports, it never edits a prompt.
//
// Generic checks, for every repository:
// - skill anatomy: frontmatter with `name` and `description`, `name` equal to
//   the folder, a trigger in the description ("Use when …"), at most 1024
//   characters;
// - agents: `name` equal to the file; a read-only agent (by `aria.config.json`)
//   lists its tools and they stay within Read, Grep, Glob and Bash; a skill the
//   body says to use is preloaded in `skills`, and every preloaded skill
//   exists (the project's, or the plugin's);
// - the model policy: an agent declares `model` and `effort`, or it runs on
//   the session's (possibly the most expensive); this plugin's own agents
//   and skills follow the table in lib/model-policy.mjs;
// - plugin agents (a repository with `.claude-plugin/plugin.json`): fields
//   Claude Code ignores for plugin agents are reported, since they would
//   silently do nothing;
// - dead paths: a path cited between backticks, under a top-level directory
//   that exists, must exist.
// Project rules: `contracts.forbidden` in `aria.config.json`, matched line by
// line against the agents, the skills, `CLAUDE.md` and `AGENTS.md`. A line
// with `aria-contracts:ignore`, or right after one, is skipped.
//
// The checks come from bernardo-pet's validate-agent-contracts.mjs, whose
// skill anatomy and dead-path ideas come from addyosmani/agent-skills (MIT);
// see THIRD_PARTY_NOTICES.md.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { AGENT_POLICY, SKILL_POLICY } from "./model-policy.mjs";

export const SKILL_DESCRIPTION_MAX = 1024;
const TRIGGER = /\bUse (when|before|after|from|only|to|for|on)\b/;
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "Bash"];
const PLUGIN_IGNORED_FIELDS = ["hooks", "mcpServers", "permissionMode", "initialPrompt"];
const SKILL_USE = /Use the `([a-z0-9:-]+)` skill\b/g;
const IGNORE_MARKER = "aria-contracts:ignore";
const PLUGIN_NAME = "aria-orchestrator";
const POLICY_FILE = "lib/model-policy.mjs";
const MEMORY_FILES = ["CLAUDE.md", "AGENTS.md"];
const PATH_TOKEN = /`([^`\s]+)`/g;
const PATH_SHAPE = /^\.?[\w-][\w.-]*(\/[\w.-]+)+\/?$/;
const TEMPLATE_MARKER = /[<>*{}$]|NNNN/;

// The frontmatter of an agent or skill: `key: value`, folded (`>`/`|`)
// text and `- item` lists. Not a YAML parser; enough for these files.
export function parseFrontmatter(source) {
	const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
	if (!match) return null;
	const fields = {};
	let key = null;
	let mode = null;
	for (const line of match[1].split(/\r?\n/)) {
		const entry = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
		if (entry) {
			key = entry[1];
			const value = entry[2].trim();
			if (value === ">" || value === "|" || value === ">-" || value === "|-") {
				fields[key] = "";
				mode = "text";
			} else if (value === "") {
				fields[key] = [];
				mode = "list";
			} else {
				fields[key] = value.replace(/^(["'])(.*)\1$/, "$2");
				mode = null;
			}
			continue;
		}
		if (!key) continue;
		const item = line.match(/^\s+-\s+(.*)$/);
		if (mode === "list" && item) fields[key].push(item[1].trim().replace(/^(["'])(.*)\1$/, "$2"));
		else if (mode === "text" && line.trim()) fields[key] = `${fields[key]} ${line.trim()}`.trim();
	}
	return fields;
}

const asList = (value) =>
	Array.isArray(value) ? value : typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];

const lineOf = (source, index) => source.slice(0, index).split("\n").length;

function listDirs(dir) {
	return existsSync(dir) ? readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory()).sort() : [];
}

function listMarkdown(dir) {
	return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".md")).sort() : [];
}

function policyFindings(file, name, meta, table, fields) {
	const entry = table[name];
	if (!entry) return [{ file, message: `"${name}" has no entry in the model policy (${POLICY_FILE})` }];
	return fields
		.filter((field) => meta[field] !== entry[field])
		.map((field) => ({
			file,
			message: `${field} "${meta[field] ?? "(none)"}" differs from the model policy for ${name} (${entry[field]})`,
		}));
}

function skillFindings(file, source, folder, { ownPlugin } = {}) {
	const meta = parseFrontmatter(source);
	if (!meta || typeof meta.name !== "string" || typeof meta.description !== "string") {
		return [{ file, message: "no frontmatter with name and description" }];
	}
	const findings = [];
	if (ownPlugin) findings.push(...policyFindings(file, folder, meta, SKILL_POLICY, ["effort"]));
	if (meta.name !== folder) findings.push({ file, message: `name "${meta.name}" differs from the folder "${folder}"` });
	if (!TRIGGER.test(meta.description)) {
		findings.push({ file, message: 'description has no trigger ("Use when …", "Use before …")' });
	}
	if (meta.description.length > SKILL_DESCRIPTION_MAX) {
		findings.push({
			file,
			message: `description has ${meta.description.length} characters (at most ${SKILL_DESCRIPTION_MAX})`,
		});
	}
	return findings;
}

function agentFindings(file, source, { readOnly, skills, pluginLayout, ownPlugin }) {
	const meta = parseFrontmatter(source);
	if (!meta || typeof meta.name !== "string" || typeof meta.description !== "string") {
		return [{ file, message: "no frontmatter with name and description" }];
	}
	const findings = [];
	const name = basename(file, ".md");
	if (ownPlugin) {
		findings.push(...policyFindings(file, name, meta, AGENT_POLICY, ["model", "effort"]));
	} else {
		// Without them the agent inherits the session's model and effort, which
		// can be the most expensive tier.
		if (meta.model === undefined) {
			findings.push({ file, message: "`model` is not declared, so the agent runs on the session's model" });
		}
		if (meta.effort === undefined) {
			findings.push({ file, message: "`effort` is not declared, so the agent runs at the session's effort" });
		}
	}
	if (meta.name !== name) findings.push({ file, message: `name "${meta.name}" differs from the file "${name}"` });
	if (readOnly.has(meta.name)) {
		if (meta.tools === undefined) {
			findings.push({ file, message: `read-only agent "${meta.name}" has no \`tools\` list, so it inherits every tool` });
		} else {
			const extra = asList(meta.tools).filter((tool) => !READ_ONLY_TOOLS.includes(tool));
			if (extra.length > 0) {
				findings.push({
					file,
					message: `read-only agent "${meta.name}" declares tools beyond ${READ_ONLY_TOOLS.join(", ")}: ${extra.join(", ")}`,
				});
			}
		}
	}
	const preloaded = asList(meta.skills);
	const bare = (skill) => skill.replace(new RegExp(`^${PLUGIN_NAME}:`), "");
	for (const skill of preloaded) {
		if (!skills.has(bare(skill))) findings.push({ file, message: `preloads the skill "${skill}", which does not exist` });
	}
	const declared = new Set(preloaded.map(bare));
	for (const match of source.matchAll(SKILL_USE)) {
		const skill = bare(match[1]);
		if (declared.has(skill)) continue;
		declared.add(skill);
		findings.push({ file, message: `says to use the \`${match[1]}\` skill but does not preload it in \`skills\`` });
	}
	if (pluginLayout) {
		for (const field of PLUGIN_IGNORED_FIELDS) {
			if (field in meta) findings.push({ file, message: `\`${field}\` is ignored for plugin agents` });
		}
	}
	return findings;
}

function ignoredLines(lines) {
	const ignored = new Set();
	lines.forEach((line, index) => {
		if (line.includes(IGNORE_MARKER)) {
			ignored.add(index);
			ignored.add(index + 1);
		}
	});
	return ignored;
}

function forbiddenFindings(file, source, forbidden) {
	const lines = source.split("\n");
	const ignored = ignoredLines(lines);
	const findings = [];
	for (const { pattern, reason } of forbidden) {
		const regex = new RegExp(pattern, "u");
		lines.forEach((line, index) => {
			if (!ignored.has(index) && regex.test(line)) findings.push({ file, line: index + 1, message: reason });
		});
	}
	return findings;
}

function deadPathFindings(root, file, source, topLevel) {
	const findings = [];
	const lines = source.split("\n");
	const ignored = ignoredLines(lines);
	for (const match of source.matchAll(PATH_TOKEN)) {
		const token = match[1].replace(/[.,:;]$/, "");
		if (!PATH_SHAPE.test(token) || TEMPLATE_MARKER.test(token)) continue;
		if (!topLevel.has(token.split("/")[0])) continue;
		const line = lineOf(source, match.index);
		if (ignored.has(line - 1)) continue;
		if (!existsSync(join(root, token))) findings.push({ file, line, message: `cites \`${token}\`, which does not exist` });
	}
	return findings;
}

// Every finding is `{file, line?, message}`, `file` relative to `root`.
export function contractFindings(root, config, { pluginRoot } = {}) {
	const manifest = join(root, ".claude-plugin", "plugin.json");
	const pluginLayout = existsSync(manifest);
	let ownPlugin = false;
	try {
		ownPlugin = pluginLayout && JSON.parse(readFileSync(manifest, "utf8")).name === PLUGIN_NAME;
	} catch {}
	const skillDirs = [join(".claude", "skills"), ...(pluginLayout ? ["skills"] : [])];
	const agentDirs = [join(".claude", "agents"), ...(pluginLayout ? ["agents"] : [])];
	const readOnly = new Set(
		Object.entries(config.agents ?? {})
			.filter(([, entry]) => entry.mode === "read-only")
			.map(([name]) => name),
	);
	const skills = new Set();
	for (const dir of [...skillDirs.map((dir) => join(root, dir)), ...(pluginRoot ? [join(pluginRoot, "skills")] : [])]) {
		for (const name of listDirs(dir)) if (existsSync(join(dir, name, "SKILL.md"))) skills.add(name);
	}
	const topLevel = new Set(listDirs(root));
	const forbidden = config.contracts?.forbidden ?? [];
	const findings = [];
	const files = [];

	for (const dir of skillDirs) {
		for (const folder of listDirs(join(root, dir))) {
			const file = join(dir, folder, "SKILL.md");
			if (!existsSync(join(root, file))) continue;
			const source = readFileSync(join(root, file), "utf8");
			files.push([file, source]);
			findings.push(...skillFindings(file, source, folder, { ownPlugin: ownPlugin && dir === "skills" }));
		}
	}
	for (const dir of agentDirs) {
		for (const name of listMarkdown(join(root, dir))) {
			const file = join(dir, name);
			const source = readFileSync(join(root, file), "utf8");
			files.push([file, source]);
			const pluginAgent = pluginLayout && dir === "agents";
			findings.push(...agentFindings(file, source, { readOnly, skills, pluginLayout: pluginAgent, ownPlugin: ownPlugin && pluginAgent }));
		}
	}
	for (const file of MEMORY_FILES) {
		if (existsSync(join(root, file))) files.push([file, readFileSync(join(root, file), "utf8")]);
	}
	for (const [file, source] of files) {
		findings.push(...forbiddenFindings(file, source, forbidden));
		findings.push(...deadPathFindings(root, file, source, topLevel));
	}
	return Object.assign(findings, { files: files.map(([file]) => file) });
}
