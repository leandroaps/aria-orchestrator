// Versioned state of an orchestration run.
//
// `.aria/runs/<run-id>/` is a disposable operational cache: the spec stays
// the source of truth. Nothing here stores a prompt, transcript, connection
// string or secret — only identities, digests and instants.
//
// What is persisted on disk is not trusted: every reader revalidates shape,
// version and relations before use, and an approval only holds while the
// plan digest and the control files stay the ones recorded.

import { createHash, randomBytes } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import {
	EVENT_ID_PATTERN,
	RUN_ID_PATTERN,
	claimEvent,
	compactTimestamp,
	eventConsumer,
	newEventId,
	readRegistry,
	registryPath,
	resolveCommonDir,
} from "./approval-registry.mjs";
import { CONFIG_FILE, STATE_DIR, externalResourcePattern, loadConfig } from "./config.mjs";
import { buildExecutionGraph, globsOverlap, resolveSpec } from "./execution-graph.mjs";
import { parseTaskBlocks } from "./spec-parsing.mjs";

export const RUN_SCHEMA_VERSION = 1;
export { EVENT_ID_PATTERN, RUN_ID_PATTERN, newEventId };
// 12 hex = 48 bits: colliding on purpose stops being trivial.
export const APPROVAL_PREFIX_LENGTH = 12;
// The whole message is the marker; a negation ("I don't approve …") or a
// quote inside a question does not match. A typed marker never approves —
// only the click recorded by the question hook does — but it is recognised
// so it can be logged as a rejection.
export const APPROVAL_MARKER_PATTERN = /^\s*(?:approve|aprovo)\s+([0-9a-f]{12,64})\s*$/i;

export const RUN_STATES = [
	"planned",
	"awaiting_approval",
	"approved",
	"running",
	"blocked",
	"ready_for_review",
	"failed",
	"cancelled",
];

// Allowed transitions. `approved` is reached only through `recordApproval`,
// which requires the human event; no other function writes that state.
const TRANSITIONS = {
	planned: ["awaiting_approval", "cancelled"],
	awaiting_approval: ["approved", "awaiting_approval", "cancelled"],
	approved: ["running", "awaiting_approval", "blocked", "cancelled"],
	running: ["blocked", "ready_for_review", "failed", "awaiting_approval", "cancelled"],
	blocked: ["running", "awaiting_approval", "cancelled", "failed"],
	ready_for_review: ["running", "cancelled"],
	failed: ["cancelled"],
	cancelled: [],
};

// Files whose change after approval voids the approval: they decide which
// hooks run and therefore which channel can approve. Paths are relative to
// the repository root, or absolute (files shipped inside the plugin).
export const CONTROL_FILES = {
	settings: ".claude/settings.json",
};

export function stateDir(root) {
	return join(root, STATE_DIR);
}

export function runsDir(root) {
	return join(stateDir(root), "runs");
}

// The registry lives in the common dir, visible from every worktree; `null`
// when the common dir cannot be proven.
export function approvalEventsPath(root) {
	const commonDir = resolveCommonDir(root);
	return commonDir ? registryPath(commonDir) : null;
}

export function newRunId(date = new Date()) {
	return `${compactTimestamp(date)}-${randomBytes(3).toString("hex")}`;
}

export function sha256(text) {
	return createHash("sha256").update(text).digest("hex");
}

export function fileDigest(root, path) {
	const absolute = resolve(root, path);
	if (!existsSync(absolute)) return null;
	return sha256(readFileSync(absolute));
}

// Atomic write: temporary file + rename in the same directory.
export function writeJsonAtomic(path, value) {
	const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(temporary, path);
}

export function readJsonl(path) {
	if (!existsSync(path)) return { entries: [], invalidLines: 0 };
	const entries = [];
	let invalidLines = 0;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			invalidLines += 1;
		}
	}
	return { entries, invalidLines };
}

// --- Semantic identity of the plan ------------------------------------------

const ACCEPTANCE_LINE = /^-\s+\*\*(R\d+\.\d+)\*\*\s+(.*)$/;
// Execution-log paragraphs do not change the plan ("Done on …", "Evidence:
// …", and their Portuguese forms). Checkboxes do not either (progress).
const EVIDENCE_PARAGRAPH =
	/^(Done on|Executed on|Evidence:|Feita em|Executada em|Evidência:)/;

function normalizeWhitespace(text) {
	return text.replace(/\s+/g, " ").trim();
}

export function acceptanceCriteria(requirementsSource) {
	const criteria = [];
	let current = null;
	for (const line of requirementsSource.split("\n")) {
		const match = line.match(ACCEPTANCE_LINE);
		if (match) {
			if (current) criteria.push(current);
			current = { id: match[1], text: match[2] };
			continue;
		}
		if (current && /^\s{2,}\S/.test(line)) {
			current.text += ` ${line.trim()}`;
			continue;
		}
		if (current) {
			criteria.push(current);
			current = null;
		}
	}
	if (current) criteria.push(current);
	return criteria.map(({ id, text }) => ({ id, text: normalizeWhitespace(text) }));
}

export function normalizedTaskBody(bodyText) {
	const withoutCheckbox = bodyText.replace(/^-\s+\[[ xX]\]\s+/, "");
	const paragraphs = withoutCheckbox
		.split(/\n\s*\n/)
		.map((paragraph) => normalizeWhitespace(paragraph))
		.filter((paragraph) => paragraph && !EVIDENCE_PARAGRAPH.test(paragraph));
	return paragraphs.join("\n");
}

export function planContract(root, specArg) {
	const config = loadConfig(root);
	const specsDir = join(root, config.specs.dir);
	const resolved = resolveSpec(specsDir, specArg);
	if (!resolved.name) {
		throw new Error(
			`spec "${specArg}" does not resolve to exactly one directory (${resolved.matches.length} found)`,
		);
	}
	const specDir = join(specsDir, resolved.name);
	const tasksSource = readFileSync(join(specDir, "tasks.md"), "utf8");
	const requirementsSource = readFileSync(join(specDir, "requirements.md"), "utf8");
	const graph = buildExecutionGraph(specsDir, resolved.name, config);
	const parsed = parseTaskBlocks(tasksSource).tasks;
	const bodies = new Map(parsed.map((task) => [task.id, task.bodyText]));
	const resources = new Map(
		parsed.map((task) => [
			task.id,
			Array.isArray(task.taskMeta?.exclusive_resources)
				? task.taskMeta.exclusive_resources
				: [],
		]),
	);
	const nodes = graph.tasks.map((task) => ({
		id: task.id,
		owner: task.owner,
		requirements: task.requirements,
		depends_on: task.depends_on,
		allowed_paths: task.allowed_paths,
		verification: task.verification,
		produces: task.produces,
		exclusive_resources: resources.get(task.id) ?? [],
		body: normalizedTaskBody(bodies.get(task.id) ?? ""),
		unknown_owner: task.unknownOwner,
	}));
	// The config decides territories and verification: changing it changes
	// the plan that was approved.
	const governance = {
		[CONFIG_FILE]: fileDigest(root, CONFIG_FILE),
	};
	return {
		spec: resolved.name,
		criteria: acceptanceCriteria(requirementsSource),
		nodes,
		governance,
	};
}

// Canonical serialisation: sorted keys, arrays in the given order.
export function canonicalJson(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value ?? null);
}

export function planDigest(contract) {
	return sha256(canonicalJson(contract));
}

// An invalid graph refuses the run before any dispatch.
export function graphProblems(contract) {
	const problems = [];
	const ids = new Set(contract.nodes.map((node) => node.id));
	for (const node of contract.nodes) {
		if (node.unknown_owner) problems.push(`${node.id}: unknown owner "${node.owner}"`);
		for (const dependency of node.depends_on) {
			if (!ids.has(dependency)) {
				problems.push(`${node.id}: missing dependency "${dependency}"`);
			}
		}
	}
	const visiting = new Set();
	const visited = new Set();
	const byId = new Map(contract.nodes.map((node) => [node.id, node]));
	const visit = (id, path) => {
		if (visited.has(id)) return;
		if (visiting.has(id)) {
			problems.push(`cycle: ${[...path, id].join(" → ")}`);
			return;
		}
		visiting.add(id);
		for (const dependency of byId.get(id)?.depends_on ?? []) {
			if (byId.has(dependency)) visit(dependency, [...path, id]);
		}
		visiting.delete(id);
		visited.add(id);
	};
	for (const node of contract.nodes) visit(node.id, []);
	return problems;
}

// --- Run manifest and events -------------------------------------------------

export function runPath(root, runId) {
	if (!RUN_ID_PATTERN.test(runId)) throw new Error(`invalid run id: "${runId}"`);
	return join(runsDir(root), runId);
}

export const RUN_EVENT_TYPES = [
	"created",
	"plan_presented",
	"approval_recorded",
	"state_changed",
	"task_started",
	"task_completed",
	"task_failed",
	"defect_recorded",
	"lock_acquired",
	"lock_released",
	"lock_recovered",
	"resumed",
];

export function appendRunEvent(root, runId, event) {
	if (!RUN_EVENT_TYPES.includes(event.type))
		throw new Error(`event type not allowed: ${event.type}`);
	appendFileSync(
		join(runPath(root, runId), "events.jsonl"),
		`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
	);
}

export function createRun(root, { spec, worktree, branch, baseCommit }) {
	const contract = planContract(root, spec);
	const problems = graphProblems(contract);
	if (problems.length > 0) {
		const error = new Error(`invalid graph: ${problems.join("; ")}`);
		error.problems = problems;
		throw error;
	}
	// The common dir is pinned in the run: a `.git` redirected later does not
	// change where the approval is looked up.
	const commonDir = resolveCommonDir(root);
	if (!commonDir) throw new Error("git common dir not proven; run not created");
	const runId = newRunId();
	const dir = runPath(root, runId);
	mkdirSync(dir, { recursive: true });
	const manifest = {
		schema_version: RUN_SCHEMA_VERSION,
		run_id: runId,
		spec: contract.spec,
		worktree,
		branch,
		base_commit: baseCommit,
		common_dir: commonDir,
		plan_digest: planDigest(contract),
		state: "planned",
		approval: null,
		lock_refs: [],
		created_at: new Date().toISOString(),
	};
	writeJsonAtomic(join(dir, "manifest.json"), manifest);
	appendRunEvent(root, runId, { type: "created", plan_digest: manifest.plan_digest });
	return manifest;
}

const MANIFEST_FIELDS = {
	schema_version: "number",
	run_id: "string",
	spec: "string",
	worktree: "string",
	branch: "string",
	base_commit: "string",
	plan_digest: "string",
	state: "string",
	created_at: "string",
};

export function manifestProblems(manifest) {
	const problems = [];
	if (!manifest || typeof manifest !== "object")
		return ["manifest missing or not an object"];
	for (const [field, type] of Object.entries(MANIFEST_FIELDS)) {
		if (typeof manifest[field] !== type)
			problems.push(`field "${field}" missing or not a ${type}`);
	}
	if (manifest.schema_version !== RUN_SCHEMA_VERSION) {
		problems.push(
			`schema_version ${manifest.schema_version} incompatible (expected ${RUN_SCHEMA_VERSION})`,
		);
	}
	if (typeof manifest.run_id === "string" && !RUN_ID_PATTERN.test(manifest.run_id)) {
		problems.push("run_id out of format");
	}
	if (!RUN_STATES.includes(manifest.state))
		problems.push(`unknown state "${manifest.state}"`);
	if (
		typeof manifest.plan_digest === "string" &&
		!/^[0-9a-f]{64}$/.test(manifest.plan_digest)
	) {
		problems.push("plan_digest is not a SHA-256");
	}
	if (manifest.state === "approved" || manifest.state === "running") {
		if (!manifest.approval)
			problems.push(`state "${manifest.state}" without an approval record`);
	}
	if (manifest.approval) {
		for (const field of [
			"event_id",
			"digest",
			"base_commit",
			"tasks_blob",
			"recorded_at",
		]) {
			if (typeof manifest.approval[field] !== "string") {
				problems.push(`approval.${field} missing`);
			}
		}
	}
	return problems;
}

export function readManifest(root, runId) {
	const path = join(runPath(root, runId), "manifest.json");
	if (!existsSync(path)) throw new Error(`run ${runId} has no manifest`);
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error(`run ${runId}: corrupted manifest`);
	}
	const problems = manifestProblems(manifest);
	if (problems.length > 0) {
		const error = new Error(`run ${runId}: invalid manifest — ${problems.join("; ")}`);
		error.problems = problems;
		throw error;
	}
	if (manifest.run_id !== runId)
		throw new Error(`run ${runId}: manifest of another run`);
	return manifest;
}

export function transition(manifest, nextState) {
	if (!(TRANSITIONS[manifest.state] ?? []).includes(nextState)) {
		throw new Error(`transition not allowed: ${manifest.state} → ${nextState}`);
	}
	if (nextState === "approved") {
		throw new Error("`approved` is only reached through record-approval");
	}
	return { ...manifest, state: nextState };
}

export function saveManifest(root, manifest) {
	const problems = manifestProblems(manifest);
	if (problems.length > 0) throw new Error(`invalid manifest: ${problems.join("; ")}`);
	writeJsonAtomic(join(runPath(root, manifest.run_id), "manifest.json"), manifest);
}

// --- Approval -----------------------------------------------------------------

// The Lead presents the plan: records the presented digest and returns the
// prefix the owner's approval must carry.
export function presentPlan(root, runId) {
	let manifest = readManifest(root, runId);
	const contract = planContract(root, manifest.spec);
	const digest = planDigest(contract);
	if (digest !== manifest.plan_digest) {
		manifest = { ...manifest, plan_digest: digest };
	}
	if (manifest.state === "planned") manifest = transition(manifest, "awaiting_approval");
	if (manifest.state !== "awaiting_approval") {
		const approvedDigest = manifest.approval?.digest;
		if (approvedDigest !== digest) manifest = transition(manifest, "awaiting_approval");
	}
	saveManifest(root, manifest);
	appendRunEvent(root, runId, { type: "plan_presented", plan_digest: digest });
	return { manifest, digest, prefix: digest.slice(0, APPROVAL_PREFIX_LENGTH) };
}

function lastPresentation(root, runId) {
	const { entries } = readJsonl(join(runPath(root, runId), "events.jsonl"));
	const presented = entries.filter((event) => event.type === "plan_presented");
	return { last: presented.at(-1) ?? null, all: presented };
}

// Human approval events from the shared registry. Only the click recorded by
// the `AskUserQuestion` hook approves; the prompt hook only records
// rejections. Text coming from a tool, a PR or a handoff never gets here.
export function humanApprovalEvents(root) {
	const commonDir = resolveCommonDir(root);
	return commonDir ? readRegistry(commonDir).approvals : [];
}

// Last rejection after `sinceIso`, for the record-approval error message.
export function lastRejectionSince(root, sinceIso) {
	const commonDir = resolveCommonDir(root);
	if (!commonDir) return null;
	const since = Date.parse(sinceIso ?? "");
	const rejections = readRegistry(commonDir).rejections.filter(
		(event) => !Number.isFinite(since) || Date.parse(event.at) > since,
	);
	return rejections.at(-1) ?? null;
}

export function lastPresentedAt(root, runId) {
	return lastPresentation(root, runId).last?.at ?? null;
}

const CLOCK_SKEW_MS = 5 * 60 * 1000;

// `acceptedHookDigests`: digests of the question hook the caller proved
// through git (the blob at the run's base commit, or a file unchanged from
// HEAD). An event written by any other hook does not approve.
export function recordApproval(
	root,
	runId,
	{ eventId, tasksBlob, headCommit, acceptedHookDigests = [] },
) {
	const manifest = readManifest(root, runId);
	if (manifest.state !== "awaiting_approval") {
		throw new Error(
			`run in "${manifest.state}": approval is only recorded in awaiting_approval`,
		);
	}
	const { last, all } = lastPresentation(root, runId);
	if (!last) throw new Error("no plan presented in this run (run `plan` first)");

	const contract = planContract(root, manifest.spec);
	const currentDigest = planDigest(contract);
	if (currentDigest !== last.plan_digest) {
		throw new Error("the plan changed after its last presentation; present it again");
	}
	const prefix = currentDigest.slice(0, APPROVAL_PREFIX_LENGTH);
	const collisions = new Set(
		all
			.map((event) => event.plan_digest)
			.filter((digest) => digest.startsWith(prefix) && digest !== currentDigest),
	);
	if (collisions.size > 0) {
		throw new Error(
			"more than one presented digest shares this prefix; approval refused",
		);
	}

	if (typeof manifest.common_dir !== "string") {
		throw new Error("manifest without common_dir: create a new run; approval refused");
	}
	const commonDir = resolveCommonDir(root);
	if (!commonDir || manifest.common_dir !== commonDir) {
		throw new Error(
			"the git common dir differs from the one pinned at run creation; approval refused",
		);
	}
	const event = humanApprovalEvents(root).find((candidate) => candidate.id === eventId);
	if (!event)
		throw new Error(`human event "${eventId}" not found or without an approval marker`);
	if (!currentDigest.startsWith(event.approves.toLowerCase())) {
		throw new Error("the approved prefix does not match the last presented plan");
	}
	if (event.approves.length < APPROVAL_PREFIX_LENGTH) {
		throw new Error(`approved prefix too short (minimum ${APPROVAL_PREFIX_LENGTH})`);
	}
	if (Date.parse(event.at) <= Date.parse(last.at)) {
		throw new Error("the human event predates the last presentation of the plan");
	}
	if (Date.parse(event.at) > Date.now() + CLOCK_SKEW_MS) {
		throw new Error("the human event is dated in the future");
	}
	if (event.run_id !== runId) {
		throw new Error(`the event approved run ${event.run_id}, not ${runId}`);
	}
	if (!acceptedHookDigests.includes(event.hook_digest)) {
		throw new Error("the event was written by a question hook other than the versioned one");
	}

	const approval = {
		event_id: event.id,
		digest: currentDigest,
		base_commit: headCommit,
		tasks_blob: tasksBlob,
		recorded_at: new Date().toISOString(),
	};
	for (const [key, path] of Object.entries(CONTROL_FILES)) {
		approval[`${key}_digest`] = fileDigest(root, path);
	}
	// Exclusive creation before saving the manifest: a second run with the
	// same event stops here.
	claimEvent(commonDir, event.id, runId);
	const updated = {
		...manifest,
		plan_digest: currentDigest,
		approval,
		state: "approved",
	};
	saveManifest(root, updated);
	appendRunEvent(root, runId, {
		type: "approval_recorded",
		event_id: event.id,
		plan_digest: currentDigest,
	});
	return updated;
}

// The approval in the manifest only counts when tied to its origin: an
// existing human event with the right prefix, a plan presented with that
// digest before the event, and `approval_recorded` in the run log, in a
// plausible time order. A hand-edited manifest does not pass here.
export function approvalProvenanceProblems(root, manifest) {
	const approval = manifest.approval;
	if (!approval) return ["no approval recorded"];
	const problems = [];
	// The registry consulted must be the one of the pinned common dir.
	if (typeof manifest.common_dir !== "string") {
		problems.push("manifest without common_dir: create a new run");
		return problems;
	}
	if (resolveCommonDir(root) !== manifest.common_dir) {
		problems.push("git common dir differs from the one pinned at run creation");
		return problems;
	}
	const { entries } = readJsonl(join(runPath(root, manifest.run_id), "events.jsonl"));
	const presented = entries.filter(
		(event) => event.type === "plan_presented" && event.plan_digest === approval.digest,
	);
	if (presented.length === 0) {
		problems.push("approval points to a digest never presented in this run");
	}
	const recorded = entries.some(
		(event) =>
			event.type === "approval_recorded" &&
			event.event_id === approval.event_id &&
			event.plan_digest === approval.digest,
	);
	if (!recorded) problems.push("approval in the manifest without an `approval_recorded` event");
	const human = humanApprovalEvents(root).find((event) => event.id === approval.event_id);
	if (!human) {
		problems.push("approval without a matching human event");
		return problems;
	}
	if (human.run_id !== manifest.run_id) problems.push("the human event approved another run");
	// The event's consumption must exist and name this run.
	if (eventConsumer(manifest.common_dir, human.id) !== manifest.run_id) {
		problems.push("approval event without a consumption recorded for this run");
	}
	if (
		typeof approval.digest !== "string" ||
		human.approves.length < APPROVAL_PREFIX_LENGTH ||
		!approval.digest.startsWith(human.approves.toLowerCase())
	) {
		problems.push("the human event approved another digest prefix");
	}
	const humanAt = Date.parse(human.at);
	const recordedAt = Date.parse(approval.recorded_at);
	const now = Date.now() + CLOCK_SKEW_MS;
	if (!Number.isFinite(humanAt) || !Number.isFinite(recordedAt)) {
		problems.push("invalid approval dates");
	} else {
		if (humanAt > now || recordedAt > now) problems.push("approval dated in the future");
		if (humanAt > recordedAt) problems.push("human event later than its recording");
		if (!presented.some((event) => Date.parse(event.at) < humanAt)) {
			problems.push("human event earlier than the presentation of the approved plan");
		}
	}
	return problems;
}

// The approval holds while the plan and the approval channel stay the ones
// recorded. A planned edit of a control file inside the current task's
// territory is released by the dispatcher, not here.
export function approvalStatus(root, manifest, { plannedControlEdits = [] } = {}) {
	if (!manifest.approval) return { valid: false, reasons: ["no approval recorded"] };
	const reasons = approvalProvenanceProblems(root, manifest);
	const contract = planContract(root, manifest.spec);
	if (planDigest(contract) !== manifest.approval.digest) {
		reasons.push("the current plan differs from the approved one (new owner decision needed)");
	}
	for (const [key, path] of Object.entries(CONTROL_FILES)) {
		if (plannedControlEdits.includes(path)) continue;
		if (fileDigest(root, path) !== manifest.approval[`${key}_digest`]) {
			reasons.push(`${path} changed after the approval`);
		}
	}
	return { valid: reasons.length === 0, reasons };
}

// --- Dispatch, concurrency and limits ----------------------------------------

export const MAX_CONCURRENT_TASKS = 3;
export const MAX_AUTOMATIC_ATTEMPTS = 3;

// Ready = every dependency `completed` with evidence still valid.
export function readiness(contract, taskStates, isEvidenceValid) {
	const byId = new Map(contract.nodes.map((node) => [node.id, node]));
	return contract.nodes.map((node) => {
		const state = taskStates[node.id];
		const blockers = [];
		for (const dependency of node.depends_on) {
			const dependencyState = taskStates[dependency];
			if (dependencyState?.state !== "completed") {
				blockers.push(`${dependency} not completed`);
			} else if (!isEvidenceValid(byId.get(dependency), dependencyState)) {
				blockers.push(`${dependency} has invalidated evidence`);
			}
		}
		return { id: node.id, owner: node.owner, state: state?.state ?? "pending", blockers };
	});
}

// Up to three concurrent tasks, one per owner, with no territory or
// exclusive resource in common with what is already running.
export function concurrencyConflicts(contract, taskStates, candidateId) {
	const byId = new Map(contract.nodes.map((node) => [node.id, node]));
	const candidate = byId.get(candidateId);
	const running = Object.values(taskStates)
		.filter((state) => state.state === "running" && state.task_id !== candidateId)
		.map((state) => byId.get(state.task_id))
		.filter(Boolean);
	const conflicts = [];
	if (running.length >= MAX_CONCURRENT_TASKS) {
		conflicts.push(
			`${running.length} tasks already running (maximum ${MAX_CONCURRENT_TASKS})`,
		);
	}
	for (const other of running) {
		if (other.owner === candidate.owner) {
			conflicts.push(`${other.id} of the same owner "${candidate.owner}" is running`);
		}
		const pathClash = candidate.allowed_paths.some((a) =>
			other.allowed_paths.some((b) => globsOverlap(a, b)),
		);
		if (pathClash) conflicts.push(`territory shared with ${other.id}, which is running`);
		const shared = candidate.exclusive_resources.filter((resource) =>
			other.exclusive_resources.includes(resource),
		);
		if (shared.length > 0) {
			conflicts.push(`exclusive resource ${shared.join(", ")} in use by ${other.id}`);
		}
	}
	return conflicts;
}

// --- Defects and attempts ----------------------------------------------------

export const DEFECT_CATEGORIES = [
	"verification_failed",
	"delta_mismatch",
	"out_of_territory",
	"sensitive_change",
	"missing_evidence",
	"other",
];

function normalizeReproduction(text) {
	return String(text)
		.toLowerCase()
		.replace(/[0-9a-f]{12,}/g, "<hash>")
		.replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z/g, "<instant>")
		.replace(/\s+/g, " ")
		.trim();
}

// Stable identity: task + requirement + category + normalised reproduction
// case. Rewording the description does not reset the counter.
export function defectKey({ task, requirement, category, reproduction }) {
	if (!DEFECT_CATEGORIES.includes(category)) {
		throw new Error(`unknown defect category: "${category}"`);
	}
	return sha256(
		[task, requirement ?? "*", category, normalizeReproduction(reproduction)].join("\n"),
	).slice(0, 16);
}

export function defectsPath(root, runId) {
	return join(runPath(root, runId), "defects.json");
}

export function readDefects(root, runId) {
	const path = defectsPath(root, runId);
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error("defects.json corrupted; resuming must revalidate");
	}
}

function noProgress(attempts) {
	const lastTwo = attempts.slice(-2);
	return (
		lastTwo.length === 2 &&
		lastTwo[0].change_digest !== null &&
		lastTwo[0].change_digest === lastTwo[1].change_digest
	);
}

// Records an observed failure and decides the next step: `blocked` on the
// third failure of the same defect, or when two attempts in a row repeat the
// defect with the same change digest.
export function recordDefect(
	root,
	runId,
	{ task, owner, requirement, category, reproduction, changeDigest },
) {
	const key = defectKey({ task, requirement, category, reproduction });
	const defects = readDefects(root, runId);
	const entry = defects[key] ?? {
		task,
		owner,
		requirement: requirement ?? "*",
		category,
		attempts: [],
	};
	entry.attempts.push({
		at: new Date().toISOString(),
		change_digest: changeDigest ?? null,
	});
	defects[key] = entry;
	writeJsonAtomic(defectsPath(root, runId), defects);
	appendRunEvent(root, runId, {
		type: "defect_recorded",
		task,
		defect_key: key,
		category,
	});

	const count = entry.attempts.length;
	let decision = "route_to_owner";
	let reason = `failure ${count}/${MAX_AUTOMATIC_ATTEMPTS} of the defect`;
	if (count >= MAX_AUTOMATIC_ATTEMPTS) {
		decision = "blocked";
		reason = `failure ${MAX_AUTOMATIC_ATTEMPTS} of the same defect: human decision needed`;
	} else if (noProgress(entry.attempts)) {
		decision = "blocked";
		reason = "two attempts in a row without a content change: no progress";
	}
	return { defect_key: key, attempts: count, decision, reason, owner, category };
}

export function taskIsBlockedByDefects(root, runId, taskId) {
	const defects = readDefects(root, runId);
	return Object.entries(defects).filter(
		([, entry]) =>
			entry.task === taskId &&
			(entry.attempts.length >= MAX_AUTOMATIC_ATTEMPTS || noProgress(entry.attempts)),
	);
}

// --- Locks shared between worktrees ------------------------------------------

const LOCK_KEY_PATTERN = /^[a-z]+:[A-Za-z0-9._:-]+$/;

export function lockFileName(key) {
	if (!LOCK_KEY_PATTERN.test(key)) throw new Error(`invalid lock key: "${key}"`);
	return `${sha256(key).slice(0, 24)}.lock`;
}

export function lockPath(locksDir, key) {
	return join(locksDir, lockFileName(key));
}

export function readLock(locksDir, key) {
	const path = lockPath(locksDir, key);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return { corrupted: true };
	}
}

// Atomic exclusive creation (`wx`). An existing lock is never taken over by
// timeout: only by `recoverLock`, which proves the holder is gone.
export function acquireLock(locksDir, key, owner) {
	mkdirSync(locksDir, { recursive: true });
	const path = lockPath(locksDir, key);
	let descriptor;
	try {
		descriptor = openSync(path, "wx");
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		const holder = readLock(locksDir, key);
		if (holder?.run_id === owner.run_id)
			return { acquired: true, reentrant: true, holder };
		return { acquired: false, holder };
	}
	const record = {
		key,
		run_id: owner.run_id,
		task_id: owner.task_id ?? null,
		worktree: owner.worktree,
		pid: owner.pid ?? process.pid,
		host: hostname(),
		acquired_at: new Date().toISOString(),
	};
	writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`);
	closeSync(descriptor);
	return { acquired: true, holder: record };
}

export function releaseLock(locksDir, key, runId) {
	const holder = readLock(locksDir, key);
	if (!holder) return { released: false, reason: "no such lock" };
	if (holder.run_id !== runId)
		return { released: false, reason: `lock belongs to ${holder.run_id}` };
	rmSync(lockPath(locksDir, key), { force: true });
	return { released: true };
}

// A lock's holder is the run (and, for a resource, the task), not the CLI
// process, which exits after every command. It is active while the state
// written in its worktree says so; unreadable state with the worktree still
// present does not prove abandonment.
function holderActivity(holder) {
	if (!holder.worktree || !RUN_ID_PATTERN.test(holder.run_id ?? "")) {
		return { active: null, reason: "incomplete lock record" };
	}
	if (!existsSync(holder.worktree))
		return { active: false, reason: "holder worktree removed" };
	const runDir = join(runsDir(holder.worktree), holder.run_id);
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
	} catch {
		return {
			active: null,
			reason: "holder run state unreadable with the worktree present",
		};
	}
	const finished = ["cancelled", "failed", "ready_for_review"].includes(manifest.state);
	if (holder.key.startsWith("worktree:")) {
		return finished
			? { active: false, reason: `holder run in "${manifest.state}"` }
			: { active: true, reason: `holder run in "${manifest.state}"` };
	}
	if (finished) return { active: false, reason: `holder run in "${manifest.state}"` };
	let task;
	try {
		task = JSON.parse(
			readFileSync(join(runDir, "tasks", `${holder.task_id}.json`), "utf8"),
		);
	} catch {
		return { active: null, reason: "holder task state unreadable" };
	}
	return task.state === "running"
		? { active: true, reason: `${holder.task_id} of the holder run is still running` }
		: { active: false, reason: `${holder.task_id} of the holder run in "${task.state}"` };
}

// Explicit recovery: only on the same host and only when the holder's state
// proves it no longer uses the lock. Elapsed time is never enough.
export function recoverLock(locksDir, key) {
	const holder = readLock(locksDir, key);
	if (!holder) return { recovered: false, reason: "no such lock" };
	if (holder.corrupted) return { recovered: false, reason: "corrupted lock: human decision" };
	if (holder.host !== hostname()) {
		return {
			recovered: false,
			reason: `holder on another host (${holder.host}): cannot be proven`,
		};
	}
	const activity = holderActivity(holder);
	if (activity.active !== false) {
		return { recovered: false, reason: `${activity.reason}: lock kept` };
	}
	rmSync(lockPath(locksDir, key), { force: true });
	return { recovered: true, reason: activity.reason, previous: holder };
}

export function resourceKeys(task) {
	return task.exclusive_resources.map((resource) => `resource:${resource}`);
}

// Resources whose exclusivity a local lock cannot prove (another clone, host
// or CI): without external coordination in place, operating on them blocks.
export function externalResources(task, config) {
	const pattern = externalResourcePattern(config);
	return task.exclusive_resources.filter((resource) => pattern.test(resource));
}
