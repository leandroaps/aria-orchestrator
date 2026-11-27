// The approval question's fixed template. `aria run plan` hands it to the
// Lead, and the question hook accepts a click only on this exact template,
// in any supported locale. The texts live in `locales/<locale>.json`.

import { readFileSync } from "node:fs";
import { RUN_ID_PATTERN } from "./approval-registry.mjs";
import { VALID_LOCALES } from "./config.mjs";

const TEXTS = Object.fromEntries(
	VALID_LOCALES.map((locale) => [
		locale,
		JSON.parse(readFileSync(new URL(`../locales/${locale}.json`, import.meta.url), "utf8")).approval,
	]),
);

const SPEC_NAME = /[A-Za-z0-9][A-Za-z0-9._-]*/;
const PREFIX = /[0-9a-f]{12}/;

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => values[key]);

export function approvalQuestion({ runId, spec, prefix }, locale = "en") {
	const text = TEXTS[locale];
	if (!text) throw new Error(`unknown locale "${locale}"`);
	const values = { runId, spec, prefix };
	return {
		question: fill(text.question, values),
		header: text.header,
		multiSelect: false,
		options: [
			{ label: fill(text.yes, values), description: text.yesDescription },
			{ label: fill(text.no, values), description: text.noDescription },
		],
	};
}

export function yesLabel(prefix, locale) {
	return fill(TEXTS[locale].yes, { prefix });
}

export function noLabel(locale) {
	return TEXTS[locale].no;
}

function questionPattern(template) {
	const groups = { runId: RUN_ID_PATTERN.source.slice(1, -1), spec: SPEC_NAME.source, prefix: PREFIX.source };
	const source = template
		.split(/(\{\w+\})/)
		.map((part) => {
			const key = part.match(/^\{(\w+)\}$/)?.[1];
			return key ? `(?<${key}>${groups[key]})` : RegExp.escape(part);
		})
		.join("");
	return new RegExp(`^${source}$`);
}

const PATTERNS = Object.entries(TEXTS).map(([locale, text]) => [locale, questionPattern(text.question)]);

const QUESTION_KEYS = new Set(["question", "header", "options", "multiSelect"]);
const OPTION_KEYS = new Set(["label", "description"]);
const onlyKeys = (value, keys) =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => keys.has(key));

// Same fields in a fixed order, `multiSelect` absent meaning false.
function normal(question) {
	return JSON.stringify([
		question.question,
		question.header,
		question.multiSelect ?? false,
		question.options.map((option) => [option.label, option.description]),
	]);
}

// Exactly the expected question: no extra key on it or on its options.
function sameQuestion(actual, expected) {
	if (!onlyKeys(actual, QUESTION_KEYS) || !Array.isArray(actual.options)) return false;
	if (!actual.options.every((option) => onlyKeys(option, OPTION_KEYS))) return false;
	return normal(actual) === normal(expected);
}

// `{ runId, spec, prefix, locale, text }` when the input holds exactly one
// question in the exact template of one locale; otherwise `null`.
export function matchApprovalTemplate(toolInput) {
	const questions = toolInput?.questions;
	if (!Array.isArray(questions) || questions.length !== 1) return null;
	const [candidate] = questions;
	if (typeof candidate?.question !== "string") return null;
	for (const [locale, pattern] of PATTERNS) {
		const match = candidate.question.match(pattern);
		if (!match) continue;
		const { runId, spec, prefix } = match.groups;
		if (sameQuestion(candidate, approvalQuestion({ runId, spec, prefix }, locale))) {
			return { runId, spec, prefix, locale, text: candidate.question };
		}
	}
	return null;
}

const HEADERS = new Set(Object.values(TEXTS).map((text) => text.header));

// A question that means to approve something: only these produce a mark or a
// rejection. An ordinary question (which spec, a doubt) has no effect.
export function looksLikeApproval(toolInput) {
	const questions = Array.isArray(toolInput?.questions) ? toolInput.questions : [];
	return questions.some(
		(question) =>
			HEADERS.has(question?.header) ||
			(Array.isArray(question?.options) &&
				question.options.some((option) => /approv|aprov/i.test(String(option?.label ?? "")))),
	);
}
