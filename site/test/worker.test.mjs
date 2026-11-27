import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker.mjs";

function fakeAssets() {
	const calls = [];
	return {
		calls,
		fetch: async (request) => {
			calls.push(request);
			return new Response("asset", { status: 200 });
		},
	};
}

test("www redirects to the apex with the same path and query", async () => {
	const ASSETS = fakeAssets();
	const response = await worker.fetch(new Request("https://www.aria-orchestrator.dev/es/?ref=x"), { ASSETS });
	assert.equal(response.status, 301);
	assert.equal(response.headers.get("location"), "https://aria-orchestrator.dev/es/?ref=x");
	assert.equal(ASSETS.calls.length, 0);
});

test("the apex is served from the static assets, unchanged", async () => {
	const ASSETS = fakeAssets();
	const request = new Request("https://aria-orchestrator.dev/pt-br/");
	const response = await worker.fetch(request, { ASSETS });
	assert.equal(response.status, 200);
	assert.equal(await response.text(), "asset");
	assert.deepEqual(ASSETS.calls, [request]);
});
