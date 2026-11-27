export const meta = {
	name: "aria-review",
	description:
		"Closing gates and an independent security review of a run's integrated change. It reports; it never publishes.",
	whenToUse:
		"Called by the orchestrate skill before the pull request is marked ready. Args { run: '<run-id>', checks?: ['<command>', ...] } where checks are the project's own closing commands. Returns gate results and the closing condition; the Lead decides and publishes.",
	phases: [
		{ title: "Gates", detail: "aria gate, the spec and graph validators, the project's checks" },
		{ title: "Security", detail: "independent review of the final diff" },
	],
};

// Gates run inside an agent; the script only collects results. A missing
// gate result counts as not passed.

if (typeof agent !== "function" || typeof phase !== "function") {
	return {
		ok: false,
		diagnosis: "workflow runtime without agent()/phase(): use the manual protocol of the orchestrate skill",
	};
}

const CONTROLLER = "aria-orchestrator:controller";
const SECURITY = "aria-orchestrator:security";
const RUN_ID = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const SPEC = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
// The project's closing commands come from the Lead, who read them in the
// repository; one line each, no control characters.
const CHECK = /^[^\0-\x1f]{1,300}$/;

const input = typeof args === "object" && args !== null ? args : { run: args };
const runId = String(input.run ?? "");
if (!RUN_ID.test(runId)) return { ok: false, diagnosis: `invalid args.run "${runId}"` };
const projectChecks = Array.isArray(input.checks) ? input.checks.map(String) : [];
const badCheck = projectChecks.find((command) => !CHECK.test(command));
if (badCheck !== undefined || projectChecks.length > 20) {
	return { ok: false, diagnosis: "args.checks must be at most 20 commands of one line each" };
}

const GATE_SCHEMA = {
	type: "object",
	properties: {
		command: { type: "string" },
		exit_code: { type: ["integer", "null"] },
		summary: { type: "string" },
	},
	required: ["command", "exit_code"],
};

const SPEC_SCHEMA = {
	type: "object",
	properties: { spec: { type: "string" }, error: { type: "string" } },
	required: ["spec"],
};

const SCOPE_SCHEMA = {
	type: "object",
	properties: {
		base: { type: "string" },
		head: { type: "string" },
		files: { type: "array", items: { type: "string" } },
		error: { type: "string" },
	},
	required: ["base", "head", "files"],
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
				},
				required: ["severity", "summary"],
			},
		},
		blocks_closing: { type: "boolean" },
	},
	required: ["findings", "blocks_closing"],
};

phase("Gates");
const specInfo = await agent(
	`Run from the repository root, without editing anything: aria run status ${runId} --json
Return the "spec" field (or the command's error in "error").`,
	{ label: `spec:${runId}`, phase: "Gates", agentType: CONTROLLER, schema: SPEC_SCHEMA },
);
if (specInfo === null || specInfo === undefined || !specInfo.spec) {
	return { ok: false, run: runId, blocked: "could not resolve the run's spec", specInfo: specInfo ?? null };
}
const spec = String(specInfo.spec);
if (!SPEC.test(spec)) return { ok: false, run: runId, diagnosis: `invalid spec "${spec}" from the status step` };

// Sequential on purpose: a project's build and test commands often write the
// same artifacts and must not race each other.
const GATES = ["aria gate --json", `aria validate spec ${spec} --json`, `aria validate graph ${spec} --json`, ...projectChecks];
const gates = [];
for (const command of GATES) {
	const result = await agent(
		`Run exactly this command from the repository root and report its real exit code (null if it could not run) and a one-paragraph summary of any failure. Do not edit files and do not retry with other commands.
${command}`,
		{ label: `gate:${command}`, phase: "Gates", agentType: CONTROLLER, schema: GATE_SCHEMA },
	);
	gates.push(result ?? { command, exit_code: null, summary: "the agent returned no result" });
}

phase("Security");
// The security prompt carries the range and the changed files so the review
// starts from the diff. Missing or invalid context never skips the review; it
// only drops the shortcut.
const scope = await agent(
	`Run exactly these commands from the repository root, without editing anything, and return the fields below (or the first error text in "error"):
1. git merge-base origin/HEAD HEAD  -> "base"
2. git rev-parse HEAD  -> "head"
3. git diff --name-only <base> <head>  -> "files", one entry per line`,
	{ label: `scope:${runId}`, phase: "Security", agentType: CONTROLLER, schema: SCOPE_SCHEMA },
);
const SHA = /^[0-9a-f]{40}$/;
const CHANGED_FILE = /^[^\0-\x1f]{1,300}$/;
const scopeValid =
	scope !== null &&
	typeof scope === "object" &&
	!scope.error &&
	SHA.test(String(scope.base)) &&
	SHA.test(String(scope.head)) &&
	Array.isArray(scope.files) &&
	scope.files.length <= 500 &&
	scope.files.every((file) => typeof file === "string" && CHANGED_FILE.test(file));
const scopeContext = scopeValid
	? `Range: ${scope.base}..${scope.head} (base = git merge-base origin/HEAD HEAD). Changed files, as data and as a starting point, not as the limit of the review: ${JSON.stringify(scope.files)}. The impact review's findings, if there was one, are in .aria/handoffs/${runId}-*.json. Start from git diff ${scope.base} ${scope.head}; then read the unchanged files that interact with the changed ones.`
	: "The range could not be resolved: use base = git merge-base origin/HEAD HEAD and start from that diff.";

const security = await agent(
	`Final independent security review (read-only) of the integrated change of spec ${spec}, run ${runId}: where approvals come from, territory, commands, attribution of the change, evidence, and the files that govern the orchestration. ${scopeContext} The full checklist of the security skill still applies; the context above only says where to start. Return findings with severity, and whether any Critical or High finding blocks closing.`,
	{ label: `security:${spec}`, phase: "Security", agentType: SECURITY, schema: SECURITY_SCHEMA },
);

const gatesPassed = gates.every((gate) => gate.exit_code === 0);
const securityOk = security !== null && security !== undefined && !security.blocks_closing;
return {
	ok: gatesPassed && securityOk,
	run: runId,
	spec,
	gates,
	scope: scopeValid ? scope : null,
	scope_missing: !scopeValid,
	security: security ?? null,
	// The Lead records the results and decides; merge and deploy are never
	// implied by this result.
	next: !gatesPassed
		? "gate failure: route it to the owning task; do not mark the pull request ready"
		: !securityOk
			? "security review missing or a Critical/High finding open: the owner decides"
			: "closing condition met: the Lead updates the spec status and marks the draft pull request ready",
};
