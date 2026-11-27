export const meta = {
	name: "aria-plan",
	description:
		"Reality check, impact, execution graph and the approval prefix for one spec. It never implements and never approves.",
	whenToUse:
		"Called by the orchestrate skill (steps 1 to 3) with args { spec: '<spec>' }. Returns the plan for the owner's decision; approval happens outside this workflow, by the owner's click.",
	phases: [
		{ title: "Reality check", detail: "what the spec claims against what the repository holds" },
		{ title: "Graph", detail: "aria validate graph, then aria run create and plan" },
		{ title: "Security", detail: "pre-dispatch review when the change is high impact" },
	],
};

// This script only coordinates: every file read and every command runs
// inside an agent, and the script never touches the filesystem or a shell.
// Values that come back from an agent are model output: each one is checked
// against a pattern before it goes into a command. A null agent result stays
// in the output as a failure, never filtered away.

if (typeof agent !== "function" || typeof phase !== "function") {
	return {
		ok: false,
		diagnosis: "workflow runtime without agent()/phase(): use the manual protocol of the orchestrate skill",
	};
}

// What this turn has spent, in output tokens, when the runtime reports it
// (`budget` is shared by the main loop and every workflow of the turn).
const spent = () => (typeof budget === "object" && budget !== null && typeof budget.spent === "function" ? budget.spent() : null);

const CONTROLLER = "aria-orchestrator:controller";
const SECURITY = "aria-orchestrator:security";
const SPEC = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const PREFIX = /^[0-9a-f]{12}$/;
const RUN_ID = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;

const spec = typeof args === "object" && args !== null ? String(args.spec ?? "") : String(args ?? "");
if (!SPEC.test(spec)) {
	return { ok: false, diagnosis: `invalid args.spec "${spec}" (expected a spec directory name or id)` };
}

const REALITY_SCHEMA = {
	type: "object",
	properties: {
		status: { type: "string", enum: ["pass", "warnings", "blocked"] },
		divergences: {
			type: "array",
			items: {
				type: "object",
				properties: {
					source: { type: "string" },
					claim: { type: "string" },
					observed: { type: "string" },
					severity: { type: "string", enum: ["blocking", "warning"] },
				},
				required: ["source", "claim", "observed", "severity"],
			},
		},
		high_impact: { type: "boolean" },
		high_impact_reason: { type: "string" },
	},
	required: ["status", "divergences", "high_impact"],
};

const PLAN_SCHEMA = {
	type: "object",
	properties: {
		graph_ok: { type: "boolean" },
		graph_output: { type: "string" },
		run_id: { type: "string" },
		state: { type: "string" },
		plan_digest: { type: "string" },
		approval_prefix: { type: "string" },
		approval_question: { type: "object" },
		tasks: {
			type: "array",
			items: {
				type: "object",
				properties: {
					id: { type: "string" },
					owner: { type: "string" },
					depends_on: { type: "array", items: { type: "string" } },
					allowed_paths: { type: "array", items: { type: "string" } },
				},
				required: ["id", "owner"],
			},
		},
		error: { type: "string" },
	},
	required: ["graph_ok"],
};

const IMPACT_SCHEMA = {
	type: "object",
	properties: {
		required: { type: "array", items: { type: "string" } },
		recommended: { type: "array", items: { type: "string" } },
		reasons: { type: "array" },
		error: { type: "string" },
	},
};

const SECURITY_SCHEMA = {
	type: "object",
	properties: {
		findings: {
			type: "array",
			items: {
				type: "object",
				properties: {
					id: { type: "string" },
					severity: { type: "string", enum: ["Critical", "High", "Medium", "Low", "Info"] },
					requirement: { type: "string" },
					summary: { type: "string" },
					recommendation: { type: "string" },
				},
				required: ["severity", "summary"],
			},
		},
		blocks_dispatch: { type: "boolean" },
	},
	required: ["findings", "blocks_dispatch"],
};

phase("Reality check");
const reality = await agent(
	`Use the reality-check skill on spec ${spec}, read-only. Deterministic checks first: files, package scripts, routes, cited specs and ADRs, and "aria validate contracts". Also judge the impact: does any path the spec's tasks touch match an impact rule in aria.config.json or the files that govern the orchestration? "aria classify" runs afterwards and can only add to your judgment. Return only the structured result.`,
	// The model policy (lib/model-policy.mjs, REALITY_CHECK): the built-in
	// Explore agent would otherwise pick its own model.
	{ label: `reality:${spec}`, phase: "Reality check", agentType: "Explore", model: "sonnet", effort: "medium", schema: REALITY_SCHEMA },
);

if (reality === null || reality === undefined) {
	return { ok: false, spec, blocked: "the reality check returned no result", reality: null };
}
if (reality.status === "blocked") {
	return { ok: false, spec, blocked: "blocking divergence: fix the documentation or get the owner's decision", reality, tokens: spent() };
}

phase("Graph");
const plan = await agent(
	`For spec ${spec}, run exactly these commands from the repository root and report their output; do not edit any file:
1. aria validate graph ${spec} --json
2. Only if (1) reported ok: aria run create ${spec} --json
3. Only if (2) returned ok: aria run plan <run.run_id from step 2> --json
Return graph_ok (true only when step 1 reported ok with no finding), the step 1 output as graph_output, and from step 3: run_id, state, plan_digest, approval_prefix, approval_question and tasks (id, owner, depends_on, allowed_paths). On any refusal, put the command's error text in "error".`,
	{ label: `graph:${spec}`, phase: "Graph", agentType: CONTROLLER, schema: PLAN_SCHEMA },
);

if (
	plan === null ||
	plan === undefined ||
	!plan.graph_ok ||
	!RUN_ID.test(String(plan.run_id ?? "")) ||
	!PREFIX.test(String(plan.approval_prefix ?? ""))
) {
	return { ok: false, spec, blocked: "the graph is invalid or no plan was produced", reality, plan: plan ?? null, tokens: spent() };
}

// High impact is the union of the reality check's judgment and
// `aria classify` over the tasks' concrete allowed paths. The classifier
// only adds. A glob, an unexpected path or a missing classifier result counts
// as high impact: closed when unsure.
const GLOB = /[*?[\]{}]/;
const SAFE_PATH = /^(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._@+-][A-Za-z0-9._@+/-]*$/;
const concretePaths = new Set();
const impactProblems = [];
const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
if (tasks.length === 0) impactProblems.push("the plan has no tasks");
for (const task of tasks) {
	if (!Array.isArray(task?.allowed_paths)) {
		impactProblems.push(`task ${String(task?.id)} has no allowed_paths list`);
		continue;
	}
	for (const raw of task.allowed_paths) {
		const path = String(raw);
		if (path.startsWith("!")) continue;
		if (GLOB.test(path)) impactProblems.push(`glob in allowed_paths: ${path}`);
		else if (SAFE_PATH.test(path)) concretePaths.add(path);
		else impactProblems.push(`unexpected path in allowed_paths: ${path}`);
	}
}

let classifier = null;
if (concretePaths.size > 0) {
	const filesJson = JSON.stringify([...concretePaths].sort());
	classifier = await agent(
		`Run exactly this command from the repository root and return the JSON it prints (fields required, recommended, reasons), or its error text in "error":
printf '%s' '${filesJson}' | aria classify --files /dev/stdin --json`,
		{ label: `impact:${spec}`, phase: "Graph", agentType: CONTROLLER, schema: IMPACT_SCHEMA },
	);
}
const classifierValid =
	classifier !== null &&
	typeof classifier === "object" &&
	!classifier.error &&
	Array.isArray(classifier.required) &&
	classifier.required.every((name) => typeof name === "string");
if (concretePaths.size > 0 && !classifierValid) impactProblems.push("the classifier returned no valid result");
const classifierMissing = impactProblems.length > 0;
const highImpact =
	reality.high_impact === true || (classifierValid && classifier.required.includes("security")) || classifierMissing;

let security = null;
if (highImpact) {
	phase("Security");
	security = await agent(
		`Pre-dispatch security review of the implementation PLAN of spec ${spec}, run ${plan.run_id} (read-only; you never edit). Read the spec and the plan ("aria run status ${plan.run_id} --json"). Focus on what the plan lets each owner write, the commands it relies on, state and evidence, and whether it touches the files that govern the orchestration. Return findings with severity, and whether any Critical or High finding blocks dispatch.`,
		{ label: `security:${spec}`, phase: "Security", agentType: SECURITY, schema: SECURITY_SCHEMA },
	);
}

const securityMissing = highImpact && (security === null || security === undefined);
return {
	ok: !securityMissing && !(security && security.blocks_dispatch),
	spec,
	reality,
	plan,
	high_impact: highImpact,
	classifier: classifierValid ? classifier : null,
	classifier_missing: classifierMissing,
	impact_problems: [...new Set(impactProblems)],
	security: security ?? null,
	security_missing: securityMissing,
	tokens: spent(),
	// This workflow ends here. Only the owner's click on the approval question
	// approves, and the question hook records it.
	next: securityMissing
		? "the security review returned nothing: rerun it or review by hand before presenting the plan"
		: security && security.blocks_dispatch
			? "Critical or High security finding: amend the plan or get an explicit owner decision"
			: `Present the plan, then ask plan.approval_question exactly as given (digest ${plan.approval_prefix}); only the owner's click approves`,
};
