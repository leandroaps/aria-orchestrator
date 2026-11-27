import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/site.yml", import.meta.url), "utf8");

// A `release` event checks out the tag by default. Deploying an older tag
// would roll the live page back to that commit's status and site, so every
// deploy builds the default branch; the releases come from the API anyway.
test("the site deploy always builds the default branch, even on a release", () => {
	assert.match(workflow, /release:\s*\n\s*types: \[published\]/);
	assert.match(
		workflow,
		/- uses: actions\/checkout@v\d+\n\s+with:\n\s+ref: \$\{\{ github\.event\.repository\.default_branch \}\}/,
	);
});

test("tests run before the deploy, in the same job", () => {
	assert.ok(workflow.indexOf("npm test") < workflow.indexOf("wrangler deploy"));
});
