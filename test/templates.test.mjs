// The spec templates the plugin ships: a spec started from them, with the
// placeholders filled in, passes `aria validate spec` and `validate graph`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { aria } from "./helpers/run-cli.mjs";
import { workspace, writeFile } from "./helpers/workspace.mjs";

const TEMPLATES = join(import.meta.dirname, "..", "templates", "spec");
const NAME = "0002-template-check";

function fill(source) {
	return source.replaceAll("NNNN", "0002").replaceAll("<title>", "Template check");
}

test("a spec started from the templates validates, with its graph", (t) => {
	const root = workspace(t);
	for (const file of ["requirements.md", "design.md", "tasks.md"]) {
		writeFile(root, `specs/${NAME}/${file}`, fill(readFileSync(join(TEMPLATES, file), "utf8")));
	}
	const spec = aria(["validate", "spec", NAME, "--json"], { cwd: root });
	assert.equal(spec.code, 0, spec.stdout + spec.stderr);
	const graph = aria(["validate", "graph", NAME, "--json"], { cwd: root });
	assert.equal(graph.code, 0, graph.stdout + graph.stderr);
	const create = aria(["run", "create", NAME, "--json"], { cwd: root });
	assert.equal(create.code, 0, create.stdout + create.stderr);
});

test("every template states its spec id and status in the header", () => {
	for (const file of ["requirements.md", "design.md", "tasks.md"]) {
		const head = readFileSync(join(TEMPLATES, file), "utf8").split("\n").slice(0, 12).join("\n");
		assert.match(head, /\*\*Spec ID:\*\* NNNN/, file);
		assert.match(head, /\*\*Status:\*\* Draft/, file);
	}
});
