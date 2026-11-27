#!/usr/bin/env node
// The `aria` command line. Plan 0001 P2 adds `validate config`; P3 adds the
// run, scope, classify and gate subcommands to the same table.
//
// Exit codes: 0 ok, 1 the checked thing is invalid, 2 usage error.

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { CONFIG_FILE, ConfigError, loadConfig } from "../lib/config.mjs";

const USAGE = `Usage: aria <command> [options]

Commands:
  validate config   Check ${CONFIG_FILE} and list every problem found

Options:
  --root <dir>      Repository root (default: current directory)
  --json            Machine-readable output, no colour or decoration
  -h, --help        Show this help`;

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

function summarize(config) {
	const agents = Object.values(config.agents);
	const writers = agents.filter((agent) => agent.mode === "write").length;
	return {
		agents: agents.length,
		writeAgents: writers,
		readOnlyAgents: agents.length - writers,
		impactRules: config.impactRules.length,
		specsDir: config.specs.dir,
		locale: config.locale,
	};
}

function validateConfig({ root, json }, out) {
	let config;
	try {
		config = loadConfig(root);
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		if (json) {
			out.stdout(JSON.stringify({ ok: false, file: CONFIG_FILE, problems: error.problems }));
		} else {
			out.stderr(error.message);
		}
		return 1;
	}
	const summary = summarize(config);
	if (json) {
		out.stdout(JSON.stringify({ ok: true, file: CONFIG_FILE, summary }));
	} else {
		out.stdout(
			`${CONFIG_FILE} is valid: ${plural(summary.agents, "agent")} ` +
				`(${summary.writeAgents} write, ${summary.readOnlyAgents} read-only), ` +
				`${plural(summary.impactRules, "impact rule")}, specs in ${summary.specsDir}/, ` +
				`locale ${summary.locale}.`,
		);
	}
	return 0;
}

const COMMANDS = {
	"validate config": validateConfig,
};

export function main(argv, out = { stdout: console.log, stderr: console.error }) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				root: { type: "string" },
				json: { type: "boolean", default: false },
				help: { type: "boolean", short: "h", default: false },
			},
		});
	} catch (error) {
		out.stderr(`${error.message}\n\n${USAGE}`);
		return 2;
	}
	const { values, positionals } = parsed;
	if (values.help) {
		out.stdout(USAGE);
		return 0;
	}
	const command = COMMANDS[positionals.join(" ")];
	if (!command) {
		const given = positionals.length > 0 ? `unknown command "${positionals.join(" ")}"` : "no command given";
		out.stderr(`${given}\n\n${USAGE}`);
		return 2;
	}
	return command({ root: resolve(values.root ?? "."), json: values.json }, out);
}

if (import.meta.main) {
	process.exitCode = main(process.argv.slice(2));
}
