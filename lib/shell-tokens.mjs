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

// Heredoc bodies are data for the command that reads them, so a reader of
// write targets must skip them, or `cat > f.mjs <<'EOF'` with an arrow
// function inside reads `=> {` as a redirect (plan 0001 P7). A body stays
// when its line feeds an interpreter, directly or through a pipe, because
// then it runs. The terminator line goes with the body; what follows it is
// kept.
const HEREDOC = /<<(-?)\s*(['"]?)([A-Za-z_][\w.-]*)\2/g;
const INTERPRETER = /(^|[\s|;&(])(?:\S*\/)?(sh|bash|zsh|dash|ksh|fish|node|nodejs|deno|bun|python[\d.]*|perl|ruby|php|lua|osascript|eval|source|xargs|env)(?=$|[\s|;&)])/;

export function withoutHeredocBodies(command) {
	const lines = command.split("\n");
	const out = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		out.push(line);
		const openers = [...line.replace(/<<</g, "   ").matchAll(HEREDOC)];
		if (openers.length === 0 || INTERPRETER.test(line)) continue;
		for (const [, dash, , delimiter] of openers) {
			index += 1;
			while (index < lines.length) {
				const candidate = dash ? lines[index].replace(/^\t+/, "") : lines[index];
				if (candidate === delimiter) break;
				index += 1;
			}
		}
	}
	return out.join("\n");
}
