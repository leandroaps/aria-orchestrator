import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

// The project runs on Node 24 everywhere: locally (.nvmrc), in package.json
// (engines), in CI (setup-node reads .nvmrc) and inside the GitHub Actions
// themselves (each action's own runtime).

const path = (relative) => new URL(`../${relative}`, import.meta.url);
const read = (relative) => readFileSync(path(relative), "utf8");

const NODE_MAJOR = 24;

// First major of each action whose action.yml declares `using: node24`
// (or, for composite actions, only calls node24 actions). An action missing
// from this table fails the test until its runtime is checked and added.
const NODE24_ACTIONS = {
	"actions/checkout": 5,
	"actions/setup-node": 5,
	"actions/configure-pages": 6,
	"actions/upload-pages-artifact": 5,
	"actions/deploy-pages": 5,
};

const workflows = readdirSync(path(".github/workflows"))
	.filter((name) => /\.ya?ml$/.test(name))
	.map((name) => ({ name, text: read(`.github/workflows/${name}`) }));

test(".nvmrc and engines pin Node 24", () => {
	assert.equal(read(".nvmrc").trim(), String(NODE_MAJOR));
	const pkg = JSON.parse(read("package.json"));
	assert.equal(pkg.engines.node, `>=${NODE_MAJOR}`);
});

test("the tests run on Node 24", () => {
	const major = Number(process.versions.node.split(".")[0]);
	assert.equal(major, NODE_MAJOR, `running on Node ${process.versions.node}; use the version in .nvmrc`);
});

test("workflows take the Node version from .nvmrc", () => {
	for (const { name, text } of workflows) {
		assert.doesNotMatch(text, /node-version\s*:/, `${name} hard-codes node-version; use node-version-file: .nvmrc`);
		if (text.includes("actions/setup-node@")) {
			assert.match(text, /node-version-file:\s*\.nvmrc/, `${name} must read .nvmrc`);
		}
	}
});

test("every action in the workflows runs on Node 24", () => {
	for (const { name, text } of workflows) {
		for (const [, action, ref] of text.matchAll(/uses:\s*([\w.-]+\/[\w.-]+)@(\S+)/g)) {
			const minimum = NODE24_ACTIONS[action];
			assert.ok(minimum, `${name}: ${action} is not in NODE24_ACTIONS; check its runtime and add it`);
			const major = Number(/^v(\d+)/.exec(ref)?.[1]);
			assert.ok(major >= minimum, `${name}: ${action}@${ref} predates Node 24; use v${minimum} or later`);
		}
	}
});
