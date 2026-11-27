import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

const pkg = read("package.json");
const plugin = read(".claude-plugin/plugin.json");
const marketplace = read(".claude-plugin/marketplace.json");

test("plugin and package share name, version and license", () => {
	assert.equal(plugin.name, pkg.name);
	assert.equal(plugin.version, pkg.version);
	assert.equal(plugin.license, "MIT");
	assert.equal(pkg.license, "MIT");
});

test("marketplace lists the plugin from the repository root", () => {
	const entry = marketplace.plugins.find((p) => p.name === plugin.name);
	assert.ok(entry, "plugin missing from marketplace.json");
	assert.equal(entry.source, "./");
});

test("engines follows the LTS pinned in .nvmrc", () => {
	const lts = readFileSync(new URL("../.nvmrc", import.meta.url), "utf8").trim();
	assert.equal(pkg.engines.node, `>=${lts}`);
});

test("version is semver", () => {
	assert.match(plugin.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
});
