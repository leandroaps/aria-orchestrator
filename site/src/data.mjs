// Data the page is built from. Everything here runs at build time, in Node;
// nothing reaches the browser.

import { readFileSync } from "node:fs";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

// The plan's phases and their state, from docs/plan/status.json.
export function loadStatus(path) {
	return { phases: readJson(path).phases };
}

// Colours from assets/brand/brand-tokens.json, the brand's single source.
export function loadTokens(path) {
	const { color } = readJson(path);
	return {
		midnight: color.midnight.value,
		snow: color.snow.value,
		violet: color.violet.value,
		muted: color.muted.value,
	};
}

const MAX_RELEASES = 5;

// GitHub release objects → the rows the page shows: no drafts, newest
// first, at most five.
export function normalizeReleases(raw) {
	return raw
		.filter((release) => !release.draft && release.published_at)
		.sort((a, b) => b.published_at.localeCompare(a.published_at))
		.slice(0, MAX_RELEASES)
		.map((release) => ({
			tag: release.tag_name,
			name: release.name || release.tag_name,
			date: release.published_at.slice(0, 10),
			url: release.html_url,
			prerelease: Boolean(release.prerelease),
		}));
}

// Releases from the GitHub API. A deploy (`required`) fails rather than
// publish an empty list when the call fails; a local build without a token
// warns and shows none.
export async function fetchReleases({ repo, token, required, fetchImpl = fetch }) {
	if (!token) {
		if (required) throw new Error("fetching releases needs a GitHub token (GITHUB_TOKEN)");
		console.warn("No GITHUB_TOKEN: building without releases.");
		return [];
	}
	const url = `https://api.github.com/repos/${repo}/releases?per_page=20`;
	const response = await fetchImpl(url, {
		headers: {
			Accept: "application/vnd.github+json",
			"User-Agent": "aria-site-build",
			Authorization: `Bearer ${token}`,
		},
	});
	if (!response.ok) throw new Error(`GitHub releases request failed: HTTP ${response.status}`);
	return normalizeReleases(await response.json());
}
