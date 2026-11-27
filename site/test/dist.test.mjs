import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

// The built site, as Cloudflare will serve it (`npm test` builds first).
const dist = (relative) => new URL(`../dist/${relative}`, import.meta.url);
const PAGES = ["index.html", "pt-br/index.html", "es/index.html"];

test("one page per language", () => {
	for (const page of PAGES) assert.ok(existsSync(dist(page)), page);
	assert.match(readFileSync(dist("pt-br/index.html"), "utf8"), /^<!doctype html>\n<html lang="pt-BR"/);
});

test("every file in public/ is served", () => {
	for (const file of readdirSync(new URL("../public/", import.meta.url))) {
		assert.ok(existsSync(dist(file)), file);
	}
});

test("files the pages reference exist in dist/", () => {
	for (const page of PAGES) {
		const html = readFileSync(dist(page), "utf8");
		const ogImage = html.match(/property="og:image" content="https:\/\/aria-orchestrator\.dev\/([^"]+)"/)[1];
		assert.ok(existsSync(dist(ogImage)), ogImage);
		for (const [, file] of html.matchAll(/(?:src|href)="\/([\w.@-]+\.(?:svg|png|webmanifest))"/g)) {
			assert.ok(existsSync(dist(file)), `${page} → ${file}`);
		}
	}
});

test("the author mark is 96 px at 1x and 192 px at 2x", () => {
	const size = (file) => {
		const bytes = readFileSync(dist(file));
		return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
	};
	assert.deepEqual(size("author-mark.png"), [96, 96]);
	assert.deepEqual(size("author-mark@2x.png"), [192, 192]);
});
