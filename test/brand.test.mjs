import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

const path = (relative) => new URL(`../${relative}`, import.meta.url);
const read = (relative) => readFileSync(path(relative));
const tokens = JSON.parse(read("assets/brand/brand-tokens.json"));
const plugin = JSON.parse(read(".claude-plugin/plugin.json"));
const page = read("site/index.html").toString();

// Width and height from the PNG IHDR chunk.
function pngSize(relative) {
	const bytes = read(relative);
	assert.equal(bytes.subarray(1, 4).toString(), "PNG", `${relative} is not a PNG`);
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const HEX = /^#[0-9A-F]{6}$/;

test("brand colours and status colours are hex values", () => {
	for (const [name, { value }] of Object.entries({ ...tokens.color, ...tokens.status })) {
		assert.match(value, HEX, name);
	}
	assert.equal(tokens.color.midnight.value, "#0B1020");
	assert.equal(tokens.color.violet.value, "#7C3AED");
	assert.equal(tokens.color.lavender.value, "#A78BFA");
	assert.equal(tokens.color.cyan.value, "#22D3EE");
	assert.equal(tokens.color.snow.value, "#F8FAFC");
});

test("every status has a symbol and an ASCII fallback", () => {
	for (const state of [
		"success",
		"warning",
		"error",
		"info",
		"pending",
		"running",
		"awaiting_approval",
		"skipped",
		"blocked",
	]) {
		const entry = tokens.status[state];
		assert.ok(entry, `status ${state} missing`);
		assert.ok(entry.symbol.length > 0);
		assert.match(entry.ascii, /^[\x20-\x7E]+$/, `${state} ASCII fallback`);
	}
});

test("logo files referenced by the tokens exist", () => {
	for (const file of [tokens.logo.source, tokens.logo.vector, tokens.logo.mark]) {
		assert.ok(existsSync(path(file)), file);
	}
});

test("the SVG logos carry no script or external reference", () => {
	for (const file of ["assets/brand/aria-icon.svg", "assets/brand/aria-mark.svg"]) {
		const svg = read(file).toString();
		assert.doesNotMatch(svg, /<script|<foreignObject|<image|\son[a-z]+=|href=/i, file);
	}
});

test("the approved logo is a square PNG usable as avatar and plugin icon", () => {
	const { width, height } = pngSize(plugin.icon);
	assert.equal(plugin.icon, tokens.logo.source);
	assert.equal(width, height);
	assert.ok(width >= 512 && width <= 2048, "plugin icon must be 512–2048 px");
	assert.ok(statSync(path(plugin.icon)).size < 1024 * 1024, "avatar must stay under 1 MB");
});

test("site copies of the logo match their sources", () => {
	assert.deepEqual(read("site/aria-mark.svg"), read("assets/brand/aria-mark.svg"));
	assert.deepEqual(read("site/favicon.svg"), read("assets/brand/aria-icon.svg"));
});

test("site raster icons have the declared sizes", () => {
	assert.deepEqual(pngSize("site/favicon-32.png"), { width: 32, height: 32 });
	assert.deepEqual(pngSize("site/apple-touch-icon.png"), { width: 180, height: 180 });
	assert.deepEqual(pngSize("site/icon-192.png"), { width: 192, height: 192 });
	assert.deepEqual(pngSize("site/icon-512.png"), { width: 512, height: 512 });
	assert.deepEqual(pngSize("site/og-image.png"), { width: 1200, height: 630 });
});

test("landing page: metadata, logo only, no external request", () => {
	assert.match(page, /<title>ARIA - Agentic SDLC Orchestrator<\/title>/);
	assert.match(
		page,
		/name="description" content="ARIA simplifies the software development lifecycle through intelligent multi-agent orchestration\."/,
	);
	assert.match(page, /name="theme-color" content="#0B1020"/);
	assert.match(page, /<img class="logo" src="aria-mark\.svg"[^>]* alt="[^"]+"/);
	// The signature exists but is off by default.
	assert.match(page, /<body data-signature="off">/);
	assert.doesNotMatch(page, /<script|<nav|<header|<footer|<form|<button/i);
	assert.doesNotMatch(page, /(src|href)="(https?:)?\/\//i, "no external request");
	assert.match(page, /prefers-reduced-motion: no-preference/);
	// Open Graph needs absolute URLs: they must point at the GitHub Pages
	// site and at a file that exists in site/.
	const PAGES = "https://www.leandroaps.com.br/aria-orchestrator/";
	assert.match(page, new RegExp(`property="og:url" content="${PAGES}"`));
	const ogImage = page.match(/property="og:image" content="([^"]+)"/)[1];
	assert.ok(ogImage.startsWith(PAGES), "og:image points at the Pages site");
	assert.ok(existsSync(path(`site/${ogImage.slice(PAGES.length)}`)), "og:image file exists");
	for (const [, file] of page.matchAll(/(?:src|href|content)="([\w.-]+\.(?:svg|png|webmanifest))"/g)) {
		assert.ok(existsSync(path(`site/${file}`)), `site/${file} is referenced but missing`);
	}
});
