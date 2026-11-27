// Read-only validators for specs, execution graphs, handoffs and runs. Each
// returns findings (plain strings); none writes a file or repairs anything.
// The CLI (`aria validate …`) prints them; hooks and the run controller call
// the same functions, so a check never has two versions.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ownerTerritories } from "./config.mjs";
import { globsOverlap, pathFitsTerritory } from "./execution-graph.mjs";
import {
	RUN_ID_PATTERN,
	approvalProvenanceProblems,
	manifestProblems,
	readJsonl,
	runsDir,
} from "./run-state.mjs";
import { definedRequirements, extractHeader, parseTaskBlocks } from "./spec-parsing.mjs";

function readIfExists(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

// Status of a spec from its requirements.md, or null when there is none.
export function specCategory(specsDir, name) {
	const source = readIfExists(join(specsDir, name, "requirements.md"));
	return source ? extractHeader(source).category : null;
}

// --- Spec ----------------------------------------------------------------------

// Checks one `<specs>/NNNN-slug/`:
// - requirements.md, design.md and tasks.md declare the same Spec ID and the
//   same Status category;
// - every task cites at least one requirement, and only requirements that
//   exist;
// - every requirement is covered by a task or by the manual/external
//   verification section.
// A spec with only requirements.md is a valid draft (reported as info). A
// Superseded spec was abandoned: only its header is checked, since nobody will
// implement the tasks it left open.
export function specFindings(specsDir, name) {
	const dir = join(specsDir, name);
	const findings = [];
	const info = [];

	const requirementsSource = readIfExists(join(dir, "requirements.md"));
	const designSource = readIfExists(join(dir, "design.md"));
	const tasksSource = readIfExists(join(dir, "tasks.md"));

	if (!requirementsSource) {
		findings.push(`${name}: requirements.md is missing; every spec needs one`);
		return { findings, info };
	}

	const header = extractHeader(requirementsSource);
	if (!header.id) findings.push(`${name}/requirements.md: no "Spec ID:" in the header`);
	if (!header.category) {
		findings.push(
			`${name}/requirements.md: Status "${header.statusText ?? "(missing)"}" does not start with Draft, Approved, Implemented or Superseded`,
		);
	}

	if (!designSource || !tasksSource) {
		info.push(
			`${name}: only requirements.md exists (Status ${header.statusText ?? "?"}); a valid draft, task coverage not checked`,
		);
		return { findings, info };
	}

	if (header.category === "Superseded") {
		info.push(`${name}: Status Superseded; task coverage not checked`);
		return { findings, info };
	}

	for (const [label, source] of [
		["design.md", designSource],
		["tasks.md", tasksSource],
	]) {
		const other = extractHeader(source);
		if (other.id && other.id !== header.id) {
			findings.push(
				`${name}/${label}: Spec ID "${other.id}" differs from requirements.md ("${header.id}")`,
			);
		}
		if (other.category && other.category !== header.category) {
			findings.push(
				`${name}/${label}: Status "${other.statusText}" differs from requirements.md ("${header.category}")`,
			);
		}
	}

	const defined = definedRequirements(requirementsSource);
	const { tasks, manualExceptions } = parseTaskBlocks(tasksSource);
	const covered = new Set(manualExceptions);
	for (const task of tasks) {
		if (task.requirements.size === 0) {
			findings.push(`${name}/tasks.md: ${task.id} cites no requirement`);
			continue;
		}
		for (const token of task.requirements) {
			covered.add(token);
			if (!defined.has(token)) {
				findings.push(`${name}/tasks.md: ${task.id} cites ${token}, which requirements.md does not define`);
			}
		}
	}
	for (const token of defined) {
		if (!covered.has(token)) {
			findings.push(
				`${name}: ${token} has no task and no manual/external verification entry`,
			);
		}
	}
	return { findings, info };
}

// --- Execution graph -------------------------------------------------------------

function findCycle(nodesById) {
	const WHITE = 0;
	const GRAY = 1;
	const BLACK = 2;
	const color = new Map([...nodesById.keys()].map((id) => [id, WHITE]));
	const path = [];
	function visit(id) {
		color.set(id, GRAY);
		path.push(id);
		for (const dependency of nodesById.get(id)?.depends_on ?? []) {
			if (!nodesById.has(dependency)) continue; // reported as missing
			if (color.get(dependency) === GRAY) {
				return [...path.slice(path.indexOf(dependency)), dependency];
			}
			if (color.get(dependency) === WHITE) {
				const found = visit(dependency);
				if (found) return found;
			}
		}
		path.pop();
		color.set(id, BLACK);
		return null;
	}
	for (const id of nodesById.keys()) {
		if (color.get(id) === WHITE) {
			const cycle = visit(id);
			if (cycle) return cycle;
		}
	}
	return null;
}

// Checks the graph built from a spec:
// - each owner is an agent in aria.config.json, each dependency exists, and
//   there is no cycle;
// - each task's allowed_paths lie inside its owner's territory;
// - two tasks of different owners with no dependency between them, in either
//   direction, do not write overlapping paths (they would race; serialize
//   them or let one freeze the contract first). Tasks of the same owner always
//   run one at a time, so they never race.
export function graphFindings(graph, config) {
	const findings = [];
	const territories = ownerTerritories(config);
	const nodesById = new Map(graph.tasks.map((task) => [task.id, task]));

	for (const task of graph.tasks) {
		const territory = Object.hasOwn(territories, task.owner) ? territories[task.owner] : null;
		if (!territory) {
			findings.push(`${task.id}: owner "${task.owner}" is not an agent in aria.config.json`);
		}
		for (const dependency of task.depends_on) {
			if (!nodesById.has(dependency)) {
				findings.push(`${task.id}: depends on "${dependency}", which is not in the graph`);
			}
		}
		if (territory) {
			for (const path of task.allowed_paths) {
				if (path.startsWith("!")) continue;
				if (!pathFitsTerritory(path, territory)) {
					findings.push(`${task.id}: allowed path "${path}" is outside the territory of "${task.owner}"`);
				}
			}
		}
	}

	const cycle = findCycle(nodesById);
	if (cycle) findings.push(`dependency cycle: ${cycle.join(" → ")}`);

	const dependsOn = (fromId, toId, seen = new Set()) => {
		if (fromId === toId) return true;
		if (seen.has(fromId)) return false;
		seen.add(fromId);
		return (nodesById.get(fromId)?.depends_on ?? []).some((dependency) =>
			dependsOn(dependency, toId, seen),
		);
	};
	for (let i = 0; i < graph.tasks.length; i += 1) {
		for (let j = i + 1; j < graph.tasks.length; j += 1) {
			const a = graph.tasks[i];
			const b = graph.tasks[j];
			if (a.owner === b.owner) continue;
			if (dependsOn(a.id, b.id) || dependsOn(b.id, a.id)) continue;
			const overlap = a.allowed_paths.some((pathA) =>
				b.allowed_paths.some((pathB) => globsOverlap(pathA, pathB)),
			);
			if (overlap) {
				findings.push(
					`${a.id} and ${b.id} do not depend on each other but write overlapping paths; serialize them or add a predecessor that freezes the contract`,
				);
			}
		}
	}
	return findings;
}

// --- Handoff ---------------------------------------------------------------------

// The JSON a worker returns when it finishes a task.
export const HANDOFF_FIELDS = [
	"agent",
	"task",
	"status",
	"requirements",
	"changed_files",
	"verification",
	"findings",
	"blocked_by",
	"next",
];
export const HANDOFF_STATUSES = ["completed", "failed", "blocked"];
const FAILURE_FIELDS = ["requirement", "owner", "expected", "observed", "reproduction"];

export function handoffShapeFindings(handoff) {
	const findings = [];
	if (typeof handoff !== "object" || handoff === null || Array.isArray(handoff)) {
		return ["the handoff must be a JSON object"];
	}
	for (const field of HANDOFF_FIELDS) {
		if (!(field in handoff)) findings.push(`required field "${field}" is missing`);
	}
	if ("status" in handoff && !HANDOFF_STATUSES.includes(handoff.status)) {
		findings.push(`status "${handoff.status}" is not one of ${HANDOFF_STATUSES.join(", ")}`);
	}
	if (!Array.isArray(handoff.changed_files)) {
		findings.push('"changed_files" must be an array, even when empty');
	}
	if (handoff.status === "failed") {
		const items = Array.isArray(handoff.findings) ? handoff.findings : [];
		if (items.length === 0) {
			findings.push('status "failed" needs at least one finding with an observable reproduction');
		}
		items.forEach((item, index) => {
			for (const field of FAILURE_FIELDS) {
				if (!(field in (item ?? {}))) findings.push(`findings[${index}] has no "${field}"`);
			}
		});
	}
	return findings;
}

// The owner comes from the graph, never from the payload, and every changed
// file must lie inside the task's allowed_paths.
export function handoffOwnershipFindings(handoff, graph) {
	const task = graph.tasks.find((candidate) => candidate.id === handoff.task);
	if (!task) return [`task "${handoff.task}" is not in the graph of ${graph.specId}`];
	const findings = [];
	if (handoff.agent && handoff.agent !== task.owner) {
		findings.push(
			`handoff.agent ("${handoff.agent}") differs from the task's owner in the graph ("${task.owner}")`,
		);
	}
	for (const file of Array.isArray(handoff.changed_files) ? handoff.changed_files : []) {
		if (!pathFitsTerritory(file, task.allowed_paths)) {
			findings.push(
				`changed file "${file}" is outside the allowed_paths of ${task.id} (${task.allowed_paths.join(", ") || "none"})`,
			);
		}
	}
	return findings;
}

// --- Run -------------------------------------------------------------------------

// Integrity of `.aria/runs/<run-id>/`: manifest shape and version, readable
// event lines, and an approval tied to an existing human event and to a plan
// that was actually presented. An invalid run is a recoverable block, never a
// success.
export function runFindings(root, runId) {
	if (!RUN_ID_PATTERN.test(runId)) return [`"${runId}" is not a run id`];
	const dir = join(runsDir(root), runId);
	const manifestPath = join(dir, "manifest.json");
	if (!existsSync(manifestPath)) return ["manifest.json is missing"];
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch {
		return ["manifest.json is not valid JSON"];
	}
	const findings = [...manifestProblems(manifest)];
	if (manifest.run_id !== runId) findings.push("manifest.run_id does not match the directory");
	const { entries, invalidLines } = readJsonl(join(dir, "events.jsonl"));
	if (invalidLines > 0) findings.push(`${invalidLines} invalid line(s) in events.jsonl`);
	if (!entries.some((event) => event.type === "created")) {
		findings.push('events.jsonl has no "created" event');
	}
	if (manifest.approval && manifest.run_id === runId) {
		findings.push(...approvalProvenanceProblems(root, manifest));
	}
	return findings;
}

export function listRunIds(root) {
	const dir = runsDir(root);
	return existsSync(dir) ? readdirSync(dir).sort() : [];
}
