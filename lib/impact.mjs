// Changed scope between two commits, and the reviews a change requires.
//
// The scope always comes from explicit refs (`--base`, `--head`), never from
// `git status` or timestamps. If the diff cannot be resolved (shallow history,
// unknown ref) it fails loudly: an empty file list would let a change through
// unreviewed.

import { hardenedGit } from "./run-evidence.mjs";

// Files that govern the orchestration itself. Changing any of them always
// requires the `security` reviewer, even when the same change edits
// aria.config.json to drop the impact rule that would ask for it. That is why
// this list lives in code and never comes from config.
// - aria.config.json: agents, territories and impact rules;
// - .claude/: hooks and permissions (settings.json), agents, skills,
//   workflows;
// - CLAUDE.md, AGENTS.md: the instructions every agent reads;
// - .github/workflows, CODEOWNERS: CI and who must review;
// - package.json: the scripts that verification commands (`npm test`) run.
export const GOVERNANCE_PATH_PATTERNS = [
	/^aria\.config\.json$/,
	/^\.claude\/settings\.json$/,
	/^\.claude\/(agents|skills|workflows|hooks)\//,
	/^(CLAUDE|AGENTS)\.md$/,
	/^\.github\/workflows\//,
	/^\.github\/CODEOWNERS$/,
	/^package\.json$/,
];
export const GOVERNANCE_REVIEWER = "security";

export function isGovernancePath(file) {
	return GOVERNANCE_PATH_PATTERNS.some((pattern) => pattern.test(file));
}

// `**` crosses directories, `*` stays inside one; everything else is literal.
function globToRegex(glob) {
	const source = glob
		.split("**")
		.map((part) => part.split("*").map((text) => RegExp.escape(text)).join("[^/]*"))
		.join(".*");
	return new RegExp(`^${source}$`);
}

// A rule matches a file when a positive pattern matches and no `!pattern`
// does: "src/app/** except src/app/api/**".
export function fileMatchesRule(file, patterns) {
	const positives = patterns.filter((pattern) => !pattern.startsWith("!"));
	const negatives = patterns.filter((pattern) => pattern.startsWith("!")).map((p) => p.slice(1));
	return (
		positives.some((pattern) => globToRegex(pattern).test(file)) &&
		!negatives.some((pattern) => globToRegex(pattern).test(file))
	);
}

export class ScopeError extends Error {
	constructor(message) {
		super(message);
		this.name = "ScopeError";
	}
}

function gitOrThrow(root, args, what) {
	try {
		return hardenedGit(root, args);
	} catch (error) {
		const cause = error.stderr?.toString().trim() || error.message;
		throw new ScopeError(
			`${what} failed; refusing to assume an empty change set (shallow history or unknown ref?): ${cause}`,
		);
	}
}

// Files changed between the merge base of `base`/`head` and `head`, the specs
// they touch, and whether any governance file changed.
export function changedScope(root, { base, head }, config) {
	if (!base || !head) throw new ScopeError("both --base and --head are required");
	const mergeBase = gitOrThrow(root, ["merge-base", base, head], `git merge-base ${base} ${head}`).trim();
	const files = gitOrThrow(
		root,
		["diff", "--name-only", "--no-renames", "-z", `${mergeBase}..${head}`],
		`git diff ${mergeBase}..${head}`,
	)
		.split("\0")
		.filter(Boolean);
	const specPattern = new RegExp(`^${RegExp.escape(config.specs.dir)}/(\\d{4})-[^/]+/`);
	const specs = [...new Set(files.map((file) => specPattern.exec(file)?.[1]).filter(Boolean))].sort();
	return {
		base: mergeBase,
		head,
		files,
		specs,
		governanceChanged: files.some(isGovernancePath),
	};
}

// Reviews a change requires and recommends, each with the rule and the files
// that triggered it. `manualRequired` (declared by the spec) only ever adds:
// an agent required by any source is never merely recommended.
export function classifyImpact(files, config, manualRequired = []) {
	const reasons = [];
	const required = new Set(manualRequired);
	const recommended = new Set();
	for (const agent of manualRequired) reasons.push({ agent, rule: "manual", files: [] });

	const governanceFiles = files.filter(isGovernancePath);
	if (governanceFiles.length > 0) {
		required.add(GOVERNANCE_REVIEWER);
		reasons.push({ agent: GOVERNANCE_REVIEWER, rule: "governance", files: governanceFiles });
	}

	for (const rule of config.impactRules) {
		const matched = files.filter((file) => fileMatchesRule(file, rule.match));
		if (matched.length === 0) continue;
		reasons.push({ agent: rule.agent, rule: rule.rule, files: matched });
		(rule.requirement === "required" ? required : recommended).add(rule.agent);
	}
	for (const agent of required) recommended.delete(agent);

	// A required reviewer that aria.config.json does not declare cannot be
	// dispatched; report it rather than drop it.
	const undeclared = [...required].filter((agent) => !Object.hasOwn(config.agents, agent)).sort();
	return {
		required: [...required].sort(),
		recommended: [...recommended].sort(),
		undeclared,
		reasons,
	};
}
