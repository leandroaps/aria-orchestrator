// Turns the SSR bundle into the static site in dist/: one index.html per
// language, plus the files in public/. Runs after `vite build --ssr`.

import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchReleases, loadStatus, loadTokens } from "../src/data.mjs";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = join(SITE, "..");
const DIST = join(SITE, "dist");

const { LOCALES, render } = await import(join(SITE, "dist-ssr", "render.js"));

const status = loadStatus(join(REPO_ROOT, "docs", "plan", "status.json"));
const tokens = loadTokens(join(REPO_ROOT, "assets", "brand", "brand-tokens.json"));
const releases = await fetchReleases({
	repo: "leandroaps/aria-orchestrator",
	token: process.env.GITHUB_TOKEN,
	// A deploy never publishes an empty list because the API call failed.
	required: process.env.GITHUB_ACTIONS === "true",
});

rmSync(DIST, { recursive: true, force: true });
cpSync(join(SITE, "public"), DIST, { recursive: true });
for (const { code, path } of LOCALES) {
	const file = join(DIST, path, "index.html");
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, render({ locale: code, status, releases, tokens }));
}
console.log(`Built ${LOCALES.length} pages with ${releases.length} release(s) into dist/.`);
