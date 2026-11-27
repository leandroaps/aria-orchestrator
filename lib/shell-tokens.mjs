// Command-line tokens for the `PreToolUse` hooks: the tool guard and the push
// gate read a command the same way.
//
// A heuristic, not a shell parser: single and double quotes group, the rest
// splits on spaces, and the outer quotes are dropped. Callers that need a
// guarantee treat what this cannot understand (`$`, backticks, subshells) as
// unresolvable instead of guessing.

export function shellTokens(command) {
	return command.match(/'[^']*'|"[^"]*"|[^\s]+/g)?.map((token) => token.replace(/^['"]|['"]$/g, "")) ?? [];
}
