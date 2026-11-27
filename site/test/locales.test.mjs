import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));
const LOCALES = ["en-US", "pt-BR", "es-ES"];
const strings = Object.fromEntries(LOCALES.map((code) => [code, read(`../src/locales/${code}.json`)]));
const status = read("../../docs/plan/status.json");

// Every leaf key, as a dotted path.
function keys(object, prefix = "") {
	return Object.entries(object).flatMap(([key, value]) =>
		typeof value === "object" ? keys(value, `${prefix}${key}.`) : [`${prefix}${key}`],
	);
}

test("every locale has exactly the en-US keys, none empty", () => {
	const reference = keys(strings["en-US"]).sort();
	for (const code of LOCALES) {
		assert.deepEqual(keys(strings[code]).sort(), reference, code);
		for (const key of reference) {
			const value = key.split(".").reduce((node, part) => node[part], strings[code]);
			assert.ok(typeof value === "string" && value.trim().length > 0, `${code}: ${key} is empty`);
		}
	}
});

test("every phase in status.json has a title in every locale", () => {
	for (const code of LOCALES) {
		for (const { id } of status.phases) assert.ok(strings[code].status.phases[id], `${code}: ${id}`);
	}
	assert.deepEqual(
		status.phases.map(({ id, title }) => [id, title]),
		status.phases.map(({ id }) => [id, strings["en-US"].status.phases[id]]),
		"en-US titles are the plan's titles",
	);
});

test("footer texts are the owner's exact copy", () => {
	assert.equal(
		strings["en-US"].footer.author,
		"Designed and built with ❤️ by Leandro Aparecido de Siqueira. All rights reserved.",
	);
	assert.equal(
		strings["pt-BR"].footer.author,
		"Projetado e desenvolvido com ❤️ por Leandro Aparecido de Siqueira. Todos os direitos reservados.",
	);
	assert.equal(
		strings["es-ES"].footer.author,
		"Diseñado y desarrollado con ❤️ por Leandro Aparecido de Siqueira. Todos los derechos reservados.",
	);
});

test("fixed English copy from the spec", () => {
	const en = strings["en-US"];
	assert.equal(en.install.prealpha, "Pre-alpha: not usable yet. v0.1.0 is tagged after real validation.");
	assert.equal(en.install.latest, "Latest release: {tag}.");
	assert.equal(en.releases.empty, "No release yet. See the status above.");
});
