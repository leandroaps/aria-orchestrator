// Terminal layer (plan 0002, B2): brand tokens turned into ANSI, colour and
// symbol detection, verbosity levels. Presentation only: nothing here reads
// run state, and `--json` output never passes through it.

import { readFileSync } from "node:fs";

const TOKENS = JSON.parse(
	readFileSync(new URL("../../assets/brand/brand-tokens.json", import.meta.url), "utf8"),
);

export const STATUS_NAMES = Object.keys(TOKENS.status);
export const VERBOSITY_LEVELS = ["minimal", "standard", "debug"];

// The nearest of the 16 basic colours, for terminals without true colour.
const BASIC = {
	success: 32,
	warning: 33,
	error: 31,
	info: 36,
	pending: 90,
	running: 35,
	awaiting_approval: 33,
	skipped: 90,
	blocked: 31,
	violet: 35,
	muted: 90,
};

const set = (value) => typeof value === "string" && value !== "";
const falsy = (value) => ["0", "false", "no", "off"].includes(String(value).toLowerCase());

// NO_COLOR (any non-empty value) always wins. Then FORCE_COLOR, either way.
// Otherwise colour needs a TTY that is not CI and not a dumb terminal.
// Unicode symbols everywhere except the Linux console and the legacy Windows
// console; WSL reports `linux` with a normal TERM and keeps Unicode.
export function detectTerminal({ env = process.env, isTTY = false, platform = process.platform } = {}) {
	let color;
	if (set(env.NO_COLOR)) color = false;
	else if (set(env.FORCE_COLOR)) color = !falsy(env.FORCE_COLOR);
	else color = Boolean(isTTY) && !set(env.CI) && env.TERM !== "dumb";
	const truecolor = color && ["truecolor", "24bit"].includes(env.COLORTERM);
	const unicode =
		platform === "win32"
			? set(env.WT_SESSION) || env.TERM_PROGRAM === "vscode" || set(env.ConEmuTask)
			: env.TERM !== "linux";
	return { color, truecolor, unicode };
}

function rgb(hex) {
	const value = Number.parseInt(hex.slice(1), 16);
	return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function hexOf(name) {
	return TOKENS.status[name]?.value ?? TOKENS.color[name]?.value;
}

export function createTheme({ color, truecolor, unicode }) {
	const paint = (name, text) => {
		if (!color) return text;
		const open = truecolor ? `38;2;${rgb(hexOf(name)).join(";")}` : String(BASIC[name]);
		return `\x1b[${open}m${text}\x1b[39m`;
	};
	const known = (name) => {
		if (!Object.hasOwn(TOKENS.status, name)) throw new Error(`unknown status "${name}"`);
		return TOKENS.status[name];
	};
	return {
		unicode,
		symbol: (name) => (unicode ? known(name).symbol : known(name).ascii),
		status: (name, text) => {
			known(name);
			return paint(name, text);
		},
		brand: (text) => paint("violet", text),
		muted: (text) => paint("muted", text),
		bold: (text) => (color ? `\x1b[1m${text}\x1b[22m` : text),
	};
}
