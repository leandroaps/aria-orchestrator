import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fetchReleases, loadStatus, loadTokens, normalizeReleases } from "../src/data.mjs";

const repoFile = (relative) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));

const release = (tag, publishedAt, extra = {}) => ({
	tag_name: tag,
	name: `Release ${tag}`,
	published_at: publishedAt,
	html_url: `https://github.com/leandroaps/aria-orchestrator/releases/tag/${tag}`,
	draft: false,
	prerelease: false,
	...extra,
});

// A fetch double that records the call and answers with a fixed response.
function fakeFetch(status, body) {
	const calls = [];
	const impl = async (url, options) => {
		calls.push({ url, options });
		return { ok: status >= 200 && status < 300, status, json: async () => body };
	};
	return { impl, calls };
}

test("normalizeReleases drops drafts and falls back to the tag for an empty name", () => {
	const rows = normalizeReleases([
		release("v0.2.0", "2026-12-01T10:00:00Z", { draft: true }),
		release("v0.1.0", "2026-11-30T10:00:00Z", { name: "", prerelease: true }),
	]);
	assert.deepEqual(rows, [
		{
			tag: "v0.1.0",
			name: "v0.1.0",
			date: "2026-11-30",
			url: "https://github.com/leandroaps/aria-orchestrator/releases/tag/v0.1.0",
			prerelease: true,
		},
	]);
});

test("normalizeReleases keeps the five newest, newest first", () => {
	const days = [3, 7, 1, 5, 2, 6, 4];
	const rows = normalizeReleases(days.map((day) => release(`v0.${day}.0`, `2026-12-0${day}T00:00:00Z`)));
	assert.deepEqual(
		rows.map((row) => row.tag),
		["v0.7.0", "v0.6.0", "v0.5.0", "v0.4.0", "v0.3.0"],
	);
	assert.equal(rows[0].date, "2026-12-07");
});

test("fetchReleases sends the token and GitHub headers, and normalizes the answer", async () => {
	const { impl, calls } = fakeFetch(200, [release("v0.1.0", "2026-12-01T00:00:00Z")]);
	const rows = await fetchReleases({ repo: "leandroaps/aria-orchestrator", token: "t", required: true, fetchImpl: impl });
	assert.equal(rows[0].date, "2026-12-01");
	assert.equal(calls[0].url, "https://api.github.com/repos/leandroaps/aria-orchestrator/releases?per_page=20");
	assert.deepEqual(calls[0].options.headers, {
		Accept: "application/vnd.github+json",
		"User-Agent": "aria-site-build",
		Authorization: "Bearer t",
	});
});

test("fetchReleases fails a required build on an HTTP error, a missing token or a network error", async () => {
	const repo = "leandroaps/aria-orchestrator";
	await assert.rejects(
		fetchReleases({ repo, token: "t", required: true, fetchImpl: fakeFetch(403, {}).impl }),
		/403/,
	);
	await assert.rejects(fetchReleases({ repo, required: true, fetchImpl: fakeFetch(200, []).impl }), /token/);
	const offline = async () => {
		throw new Error("getaddrinfo ENOTFOUND api.github.com");
	};
	await assert.rejects(fetchReleases({ repo, token: "t", required: true, fetchImpl: offline }), /ENOTFOUND/);
});

test("fetchReleases without a token, when not required, warns once and returns no releases", async (t) => {
	const warn = t.mock.method(console, "warn", () => {});
	const { impl, calls } = fakeFetch(200, [release("v0.1.0", "2026-12-01T00:00:00Z")]);
	assert.deepEqual(await fetchReleases({ repo: "leandroaps/aria-orchestrator", required: false, fetchImpl: impl }), []);
	assert.equal(calls.length, 0);
	assert.equal(warn.mock.callCount(), 1);
});

test("loadStatus and loadTokens read the repository's files", () => {
	const status = loadStatus(repoFile("docs/plan/status.json"));
	assert.equal(status.phases.length, 9);
	assert.deepEqual(status.phases[0], { id: "P0", title: "Scaffold", state: "done" });
	assert.deepEqual(loadTokens(repoFile("assets/brand/brand-tokens.json")), {
		midnight: "#0B1020",
		snow: "#F8FAFC",
		violet: "#7C3AED",
		lavender: "#A78BFA",
		muted: "#94A3B8",
	});
});
