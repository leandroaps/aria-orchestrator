// Execution graph of a spec: one node per task, with owner, dependencies,
// territory and verification. Shared by every tool that needs "the graph",
// so they never disagree about it.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FALLBACK_VERIFICATION, ownerTerritories, ownerVerification } from "./config.mjs";
import { parseDependencyGraphSection, parseTaskBlocks } from "./spec-parsing.mjs";

function hasPathTraversal(path) {
	return path.split("/").includes("..");
}

// A path fits a territory when, after rejecting `..`, it equals an exact
// pattern (no `**`) or starts with the base of a glob (`dir/**` → `dir/`,
// which carries the directory boundary). A pattern without `**` never matches
// by prefix: `config.json-evil` does not fit `config.json`. `!pattern`
// entries carve exclusions out of the positives.
export function pathFitsTerritory(path, territory) {
	if (territory.length === 0 || hasPathTraversal(path)) return false;
	const matches = (pattern) => {
		if (pattern === path) return true;
		if (!pattern.includes("**")) return false;
		const base = pattern.replace(/\*\*.*$/, "");
		return path.startsWith(base);
	};
	const positives = territory.filter((pattern) => !pattern.startsWith("!"));
	const negatives = territory
		.filter((pattern) => pattern.startsWith("!"))
		.map((pattern) => pattern.slice(1));
	return positives.some(matches) && !negatives.some(matches);
}

// Directory base of a glob, to compare two territories with each other. A
// pattern without `**` is an exact file (its base is itself).
function globBase(pattern) {
	return pattern.includes("**") ? pattern.replace(/\*\*.*$/, "") : pattern;
}

// Two patterns collide when one lies inside the other. Comparing raw strings
// fails when `**` sits at different depths (`src/components/**` contains
// `src/components/schedule/**`, yet neither string is a prefix of the other).
export function globsOverlap(patternA, patternB) {
	if (patternA.startsWith("!") || patternB.startsWith("!")) return false;
	const baseA = globBase(patternA);
	const baseB = globBase(patternB);
	return baseA === baseB || baseA.startsWith(baseB) || baseB.startsWith(baseA);
}

export function listSpecDirs(specsDir) {
	return readdirSync(specsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && /^\d{4}-/.test(entry.name))
		.map((entry) => entry.name)
		.sort();
}

export function resolveSpec(specsDir, arg) {
	const names = listSpecDirs(specsDir);
	const matches = names.filter((name) => name === arg || name.startsWith(`${arg}-`));
	if (matches.length !== 1) return { matches };
	return { name: matches[0], matches };
}

// Never invents a task, requirement or owner absent from the spec and the
// config; defaults apply only where the task did not set its own value.
export function buildExecutionGraph(specsDir, name, config) {
	const territories = ownerTerritories(config);
	const verifications = ownerVerification(config);
	const dir = join(specsDir, name);
	const tasksSource = readFileSync(join(dir, "tasks.md"), "utf8");

	const { tasks } = parseTaskBlocks(tasksSource);
	const graphEdges = parseDependencyGraphSection(tasksSource);
	const orderedIds = tasks.map((t) => t.id);

	const nodes = tasks.map((task, index) => {
		const owner = (task.owner ?? "unknown").toLowerCase();
		const territory = Object.hasOwn(territories, owner) ? territories[owner] : null;

		// `depends_on: []` (a root on purpose) differs from a missing key: only
		// the missing key falls back to the graph section or to file order.
		let dependsOn;
		if (task.taskMeta && Array.isArray(task.taskMeta.depends_on)) {
			dependsOn = task.taskMeta.depends_on;
		} else if (graphEdges) {
			dependsOn = graphEdges[task.id] ?? [];
		} else {
			dependsOn = index > 0 ? [orderedIds[index - 1]] : [];
		}

		return {
			id: task.id,
			owner,
			requirements: [...task.requirements].sort(),
			depends_on: dependsOn,
			inputs: task.taskMeta?.inputs?.length
				? task.taskMeta.inputs
				: [
						`${config.specs.dir}/${name}/requirements.md`,
						`${config.specs.dir}/${name}/design.md`,
						`${config.specs.dir}/${name}/tasks.md`,
					],
			// An explicit `allowed_paths: []` means "no writes", not "the
			// owner's whole territory": task-meta only narrows a territory,
			// never widens it. The owner's exclusions (`!pattern`) carry over to
			// a non-empty narrowed list. Only a missing key inherits the
			// territory.
			allowed_paths: Array.isArray(task.taskMeta?.allowed_paths)
				? [
						...task.taskMeta.allowed_paths,
						...(territory ?? []).filter(
							(pattern) =>
								task.taskMeta.allowed_paths.length > 0 &&
								pattern.startsWith("!") &&
								!task.taskMeta.allowed_paths.includes(pattern),
						),
					]
				: (territory ?? []),
			verification: task.taskMeta?.verification?.length
				? task.taskMeta.verification
				: Object.hasOwn(verifications, owner)
					? verifications[owner]
					: FALLBACK_VERIFICATION,
			produces: task.taskMeta?.produces ?? [],
			unknownOwner: territory === null,
		};
	});

	return {
		specId: name,
		usedExplicitDependencyGraph: graphEdges !== null,
		tasks: nodes,
	};
}
