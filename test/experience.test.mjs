import assert from "node:assert/strict";
import { test } from "node:test";
import { STATUS_NAMES, VERBOSITY_LEVELS, createTheme, detectTerminal } from "../lib/experience/terminal.mjs";

const TTY = { isTTY: true, platform: "darwin" };

test("colour: on for a TTY, off when piped", () => {
	assert.equal(detectTerminal({ ...TTY, env: {} }).color, true);
	assert.equal(detectTerminal({ ...TTY, isTTY: false, env: {} }).color, false);
});

test("colour: NO_COLOR wins over a TTY and over FORCE_COLOR", () => {
	assert.equal(detectTerminal({ ...TTY, env: { NO_COLOR: "1" } }).color, false);
	assert.equal(detectTerminal({ ...TTY, env: { NO_COLOR: "1", FORCE_COLOR: "1" } }).color, false);
	// An empty NO_COLOR does not count (no-color.org).
	assert.equal(detectTerminal({ ...TTY, env: { NO_COLOR: "" } }).color, true);
});

test("colour: FORCE_COLOR turns it on when piped, FORCE_COLOR=0 turns it off", () => {
	assert.equal(detectTerminal({ ...TTY, isTTY: false, env: { FORCE_COLOR: "1" } }).color, true);
	assert.equal(detectTerminal({ ...TTY, env: { FORCE_COLOR: "0" } }).color, false);
	assert.equal(detectTerminal({ ...TTY, env: { FORCE_COLOR: "false" } }).color, false);
});

test("colour: off on CI and on a dumb terminal, unless forced", () => {
	assert.equal(detectTerminal({ ...TTY, env: { CI: "true" } }).color, false);
	assert.equal(detectTerminal({ ...TTY, env: { TERM: "dumb" } }).color, false);
	assert.equal(detectTerminal({ ...TTY, env: { CI: "true", FORCE_COLOR: "1" } }).color, true);
});

test("true colour only when the terminal says so", () => {
	assert.equal(detectTerminal({ ...TTY, env: {} }).truecolor, false);
	assert.equal(detectTerminal({ ...TTY, env: { COLORTERM: "truecolor" } }).truecolor, true);
	assert.equal(detectTerminal({ ...TTY, env: { COLORTERM: "24bit" } }).truecolor, true);
	assert.equal(detectTerminal({ ...TTY, env: { COLORTERM: "truecolor", NO_COLOR: "1" } }).truecolor, false);
});

test("Unicode symbols, with ASCII on the Linux console and the legacy Windows console", () => {
	assert.equal(detectTerminal({ ...TTY, env: {} }).unicode, true);
	assert.equal(detectTerminal({ ...TTY, platform: "linux", env: { TERM: "linux" } }).unicode, false);
	// WSL reports linux with a normal TERM: Unicode.
	assert.equal(detectTerminal({ ...TTY, platform: "linux", env: { TERM: "xterm-256color", WSL_DISTRO_NAME: "Ubuntu" } }).unicode, true);
	assert.equal(detectTerminal({ ...TTY, platform: "win32", env: {} }).unicode, false);
	assert.equal(detectTerminal({ ...TTY, platform: "win32", env: { WT_SESSION: "x" } }).unicode, true);
	assert.equal(detectTerminal({ ...TTY, platform: "win32", env: { TERM_PROGRAM: "vscode" } }).unicode, true);
});

test("theme: symbols come from the brand tokens, with their ASCII fallbacks", () => {
	const unicode = createTheme({ color: false, truecolor: false, unicode: true });
	const ascii = createTheme({ color: false, truecolor: false, unicode: false });
	assert.equal(unicode.symbol("success"), "✓");
	assert.equal(unicode.symbol("awaiting_approval"), "◆");
	assert.equal(ascii.symbol("success"), "[ok]");
	assert.equal(ascii.symbol("blocked"), "[#]");
	assert.deepEqual(STATUS_NAMES, [
		"success",
		"warning",
		"error",
		"info",
		"pending",
		"running",
		"awaiting_approval",
		"skipped",
		"blocked",
	]);
	assert.throws(() => unicode.symbol("nope"), /unknown status/);
});

test("theme: no escape code without colour", () => {
	const theme = createTheme({ color: false, truecolor: false, unicode: true });
	assert.equal(theme.status("error", "boom"), "boom");
	assert.equal(theme.brand("ARIA"), "ARIA");
	assert.equal(theme.muted("x"), "x");
	assert.equal(theme.bold("x"), "x");
});

test("theme: true colour paints the token's exact RGB", () => {
	const theme = createTheme({ color: true, truecolor: true, unicode: true });
	// error #F87171 = 248,113,113
	assert.equal(theme.status("error", "boom"), "\x1b[38;2;248;113;113mboom\x1b[39m");
	// violet #7C3AED = 124,58,237
	assert.equal(theme.brand("ARIA"), "\x1b[38;2;124;58;237mARIA\x1b[39m");
	assert.equal(theme.bold("x"), "\x1b[1mx\x1b[22m");
});

test("theme: without true colour, the nearest of the 16 basic colours", () => {
	const theme = createTheme({ color: true, truecolor: false, unicode: true });
	assert.equal(theme.status("success", "ok"), "\x1b[32mok\x1b[39m");
	assert.equal(theme.status("error", "x"), "\x1b[31mx\x1b[39m");
	assert.equal(theme.status("warning", "x"), "\x1b[33mx\x1b[39m");
	assert.equal(theme.status("pending", "x"), "\x1b[90mx\x1b[39m");
	assert.equal(theme.brand("ARIA"), "\x1b[35mARIA\x1b[39m");
});

test("verbosity levels, minimal first", () => {
	assert.deepEqual(VERBOSITY_LEVELS, ["minimal", "standard", "debug"]);
});
