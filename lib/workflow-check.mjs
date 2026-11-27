// Static checks on a Claude Code workflow script (`workflows/*.js`), from the
// rules the workflow runtime documents and the ones the orchestration adds:
// - `export const meta` opens the file and is a plain object literal, or the
//   workflow drops out of autocomplete;
// - `meta.name` matches the file name and `meta.description` is present;
// - every phase listed in `meta.phases` is opened with the same title;
// - the body compiles as the runtime runs it (top-level `await` and `return`);
// - no module loading, filesystem, shell or `process` (agents do that, the
//   script only coordinates), no clock or randomness (the runtime throws),
//   and no `.filter(Boolean)`, which hides a stopped agent's `null` result.
// Nothing here runs the script: the meta literal is evaluated in an empty
// context, and the body is only compiled.

import vm from "node:vm";

export const REQUIRED_WORKFLOWS = ["aria-plan", "aria-execute", "aria-review"];

const FORBIDDEN = [
	[/^\s*import\s|\bimport\s*\(/m, "module import"],
	[/\brequire\s*\(/, "require()"],
	[/\bprocess\s*\./, "access to process"],
	[/\bfs\s*\.|node:|child_process|\bexecSync\b|\bspawn\s*\(/, "direct filesystem or shell access"],
	[/\bDate\s*\.\s*now\s*\(|\bMath\s*\.\s*random\s*\(|\bnew\s+Date\s*\(\s*\)/, "clock or randomness (the runtime throws; pass a timestamp in args)"],
	[/\.filter\(\s*Boolean\s*\)/, "filter(Boolean) hides a null result"],
];

// Blanks the text of comments and string literals, keeping the code inside
// template `${…}` expressions, so prose in a prompt never matches a rule.
export function codeOnly(source) {
	let out = "";
	const templates = []; // brace depth at each open `${`
	let depth = 0;
	let i = 0;
	const blank = (text) => text.replace(/[^\n]/g, " ");
	while (i < source.length) {
		const char = source[i];
		const next = source[i + 1];
		if (char === "/" && next === "/") {
			const end = source.indexOf("\n", i);
			const stop = end === -1 ? source.length : end;
			out += blank(source.slice(i, stop));
			i = stop;
		} else if (char === "/" && next === "*") {
			const end = source.indexOf("*/", i + 2);
			const stop = end === -1 ? source.length : end + 2;
			out += blank(source.slice(i, stop));
			i = stop;
		} else if (char === '"' || char === "'") {
			let j = i + 1;
			while (j < source.length && source[j] !== char && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
			out += `${char}${blank(source.slice(i + 1, j))}${char}`;
			i = j + 1;
		} else if (char === "`" || (char === "}" && templates.length > 0 && templates.at(-1) === depth)) {
			// Template text up to the closing backtick or the next `${`.
			if (char === "}") templates.pop();
			let j = i + 1;
			while (j < source.length && source[j] !== "`" && !(source[j] === "$" && source[j + 1] === "{")) {
				j += source[j] === "\\" ? 2 : 1;
			}
			out += `${char}${blank(source.slice(i + 1, j))}`;
			if (source[j] === "$") {
				templates.push(depth);
				out += "${";
				i = j + 2;
			} else {
				out += "`";
				i = j + 1;
			}
		} else {
			if (char === "{") depth += 1;
			if (char === "}") depth -= 1;
			out += char;
			i += 1;
		}
	}
	return out;
}

function extractMeta(source) {
	const start = source.search(/export const meta\s*=\s*\{/);
	if (start === -1) return { error: "no `export const meta = {...}`" };
	if (codeOnly(source.slice(0, start)).trim() !== "") {
		return { error: "`export const meta` must open the file" };
	}
	const open = source.indexOf("{", start);
	const code = codeOnly(source);
	let depth = 0;
	for (let i = open; i < code.length; i += 1) {
		if (code[i] === "{") depth += 1;
		else if (code[i] === "}") {
			depth -= 1;
			if (depth === 0) {
				const end = code[i + 1] === ";" ? i + 2 : i + 1;
				return { text: source.slice(open, i + 1), code: code.slice(open, i + 1), body: source.slice(end) };
			}
		}
	}
	return { error: "`export const meta` is not closed" };
}

// The literal `meta` and the body the runtime runs (top-level `await` and
// `return`), or `{ error }` when `meta` does not open the file.
export function splitWorkflow(source) {
	const meta = extractMeta(source);
	if (meta.error) return { error: meta.error };
	return { meta: vm.runInNewContext(`(${meta.text})`, {}, { timeout: 50 }), body: meta.body };
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function workflowProblems(name, source) {
	const meta = extractMeta(source);
	if (meta.error) return [meta.error];
	const problems = [];
	if (/\$\{|\.\.\.|\b[A-Za-z_$][\w$]*\s*\(/.test(meta.code)) {
		problems.push("meta is not a plain literal (interpolation, spread or call)");
	} else {
		try {
			const value = vm.runInNewContext(`(${meta.text})`, {}, { timeout: 50 });
			if (value.name !== name) problems.push(`meta.name "${value.name}" differs from the file "${name}"`);
			if (typeof value.description !== "string" || value.description === "") {
				problems.push("meta.description is missing");
			}
			for (const entry of Array.isArray(value.phases) ? value.phases : []) {
				const title = String(entry?.title ?? "");
				const opened = new RegExp(`\\bphase\\(\\s*(["'\`])${escapeRegExp(title)}\\1\\s*\\)`);
				if (!opened.test(meta.body)) problems.push(`phase "${title}" is listed in meta but never opened`);
			}
		} catch (error) {
			problems.push(`meta is invalid: ${error.message}`);
		}
	}
	try {
		new vm.Script(`(async function () {\n${meta.body}\n})`, { filename: `${name}.js` });
	} catch (error) {
		problems.push(`syntax: ${error.message}`);
	}
	const body = codeOnly(meta.body);
	for (const [pattern, label] of FORBIDDEN) {
		if (pattern.test(body)) problems.push(`not allowed in a workflow: ${label}`);
	}
	return problems;
}
