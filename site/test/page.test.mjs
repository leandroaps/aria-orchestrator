import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
// Built by `npm run build`, which `npm test` runs first (pretest).
import { LOCALES, render } from "../dist-ssr/render.js";

const status = JSON.parse(readFileSync(new URL("../../docs/plan/status.json", import.meta.url), "utf8"));
const tokens = { midnight: "#0B1020", snow: "#F8FAFC", violet: "#7C3AED", lavender: "#A78BFA", muted: "#94A3B8" };
const RELEASE = {
	tag: "v0.1.0",
	name: "First release",
	date: "2026-12-01",
	url: "https://github.com/leandroaps/aria-orchestrator/releases/tag/v0.1.0",
	prerelease: false,
};
const page = (options = {}) => render({ locale: "en-US", status, releases: [], tokens, ...options });
const section = (html, id) => html.match(new RegExp(`<section id="${id}"[\\s\\S]*?</section>`))[0];

test("signature copy, in English in every locale", () => {
	for (const { code } of LOCALES) {
		const html = page({ locale: code });
		assert.match(html, /<h1>ARIA<\/h1>/);
		for (const text of ["Agentic SDLC Orchestrator", "Complexity orchestrated.", "Simplicity delivered."]) {
			assert.ok(html.includes(text), `${code}: ${text}`);
		}
	}
});

test("install shows the commands and the pre-alpha line without releases", () => {
	const install = section(page(), "install");
	assert.ok(install.includes("/plugin marketplace add leandroaps/aria-orchestrator"));
	assert.ok(install.includes("/plugin install aria-orchestrator@aria"));
	assert.ok(install.includes("Pre-alpha: not usable yet. v0.1.0 is tagged after real validation."));
});

test("install names the latest release when one exists", () => {
	const install = section(page({ releases: [RELEASE] }), "install");
	assert.ok(install.includes("Latest release: v0.1.0."));
	assert.ok(!install.includes("Pre-alpha"));
});

test("status rows match status.json, with the state as word and symbol", () => {
	const rows = [...section(page(), "status").matchAll(/<li[^>]*data-state="([^"]+)"[\s\S]*?<\/li>/g)];
	assert.equal(rows.length, 9);
	assert.deepEqual(
		rows.map((row) => row[1]),
		status.phases.map((phase) => phase.state),
	);
	assert.match(rows[3][0], /→[\s\S]*CLI[\s\S]*In progress/);
	assert.match(rows[0][0], /✓[\s\S]*Scaffold[\s\S]*Done/);
	assert.equal(rows.filter((row) => row[0].includes("→")).length, 1);
	const pt = section(page({ locale: "pt-BR" }), "status");
	assert.ok(pt.includes("Em andamento"));
});

test("releases: empty state, rows with a localized date, prerelease label", () => {
	assert.ok(section(page(), "releases").includes("No release yet. See the status above."));
	const releases = section(page({ releases: [RELEASE, { ...RELEASE, tag: "v0.1.0-rc.1", prerelease: true }] }), "releases");
	assert.ok(releases.includes(`href="${RELEASE.url}"`));
	assert.ok(releases.includes("Dec 1, 2026"));
	assert.ok(releases.includes("pre-release"));
	assert.ok(section(page({ locale: "pt-BR", releases: [RELEASE] }), "releases").includes("1 de dez. de 2026"));
});

test("release text is escaped", () => {
	const html = page({ releases: [{ ...RELEASE, name: "<script>alert(1)</script>" }] });
	assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
	assert.ok(!html.includes("<script>alert(1)"));
});

test("html lang, hreflang alternates and canonical per locale", () => {
	const urls = { "en-US": "https://aria-orchestrator.dev/", "pt-BR": "https://aria-orchestrator.dev/pt-br/", "es-ES": "https://aria-orchestrator.dev/es/" };
	for (const { code } of LOCALES) {
		const html = page({ locale: code });
		assert.match(html, new RegExp(`<html lang="${code}"`));
		assert.ok(html.includes(`<link rel="canonical" href="${urls[code]}"/>`), code);
		assert.ok(html.includes(`<meta property="og:url" content="${urls[code]}"/>`), code);
		for (const [other, url] of Object.entries(urls)) {
			assert.ok(html.includes(`<link rel="alternate" hrefLang="${other}" href="${url}"/>`), `${code} → ${other}`);
		}
		assert.ok(html.includes('<link rel="alternate" hrefLang="x-default" href="https://aria-orchestrator.dev/"/>'));
	}
});

test("controls: language links mark the current page, and the theme button", () => {
	const html = page({ locale: "pt-BR" });
	const controls = html.match(/<nav class="controls"[\s\S]*?<\/nav>/)[0];
	assert.match(controls, /<a href="\/pt-br\/" hrefLang="pt-BR" lang="pt-BR" aria-current="page"[^>]*>PT<\/a>/);
	assert.match(controls, /<a href="\/" hrefLang="en-US" lang="en-US"[^>]*>EN<\/a>/);
	assert.match(controls, /<a href="\/es\/" hrefLang="es-ES" lang="es-ES"[^>]*>ES<\/a>/);
	assert.equal((controls.match(/aria-current/g) ?? []).length, 1);
	assert.match(controls, /<button type="button" id="theme-toggle"[^>]*data-label-light="Tema claro" data-label-dark="Tema escuro"/);
});

test("exactly one inline script, in head, with no src, fetch or URL", () => {
	const html = page();
	const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
	assert.equal(scripts.length, 1);
	assert.equal(scripts[0][1].trim(), "");
	assert.doesNotMatch(scripts[0][2], /fetch|XMLHttpRequest|http/);
	assert.ok(html.indexOf("<script") < html.indexOf("</head>"));
	assert.match(scripts[0][2], /localStorage/);
});

test("no external origin except github.com links and the canonical domain", () => {
	const html = page({ releases: [RELEASE] });
	for (const [, attribute, url] of html.matchAll(/\b(src|href|srcSet|content)="(https?:\/\/[^"]+)"/g)) {
		const host = new URL(url).host;
		if (attribute === "href" && host === "github.com") continue;
		assert.equal(host, "aria-orchestrator.dev", `${attribute}="${url}"`);
	}
	assert.doesNotMatch(html, /fonts\.googleapis|api\.github\.com/);
});

test("footer has the author mark and the locale's text", () => {
	const footer = page({ locale: "es-ES" }).match(/<footer[\s\S]*<\/footer>/)[0];
	assert.match(footer, /<img src="\/author-mark\.png" srcSet="\/author-mark@2x\.png 2x" width="32" height="32" alt="" loading="lazy"/);
	assert.ok(footer.includes("Diseñado y desarrollado con ❤️ por Leandro Aparecido de Siqueira. Todos los derechos reservados."));
	assert.ok(footer.includes('href="https://github.com/leandroaps/aria-orchestrator"'));
});

test("only the logo is preloaded, not the footer image", () => {
	const preloads = [...page().matchAll(/<link rel="preload"[^>]*>/g)].map((match) => match[0]);
	assert.deepEqual(preloads, ['<link rel="preload" as="image" href="/aria-mark.svg"/>']);
});
