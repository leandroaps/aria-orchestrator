// `aria status`: the run summary as terminal lines. Real state only — the
// summary comes from `summaryCommand`; this file only chooses symbols,
// colours and how much to show.
//
// Verbosity: `minimal` (default) shows what needs attention; `standard`
// lists every task; `debug` adds digests and paths. A pending or voided
// approval and the last failure show at every level.

const RUN_STATE_STATUS = {
	planned: "pending",
	awaiting_approval: "awaiting_approval",
	approved: "success",
	running: "running",
	blocked: "blocked",
	ready_for_review: "success",
	failed: "error",
	cancelled: "skipped",
};

const TASK_STATE_STATUS = {
	pending: "pending",
	running: "running",
	completed: "success",
	failed: "error",
	unknown: "warning",
};

export function renderRunStatus(summary, { theme, verbosity = "minimal", terminal, runDir }) {
	const mark = (status, text) => `${theme.status(status, theme.symbol(status))} ${text}`;
	const lines = [`${theme.bold(theme.brand("ARIA"))} · run ${summary.run_id} · ${summary.spec}`];
	const runStatus = RUN_STATE_STATUS[summary.state] ?? "warning";
	lines.push(mark(runStatus, theme.status(runStatus, summary.state)));

	const { approval } = summary;
	if (!approval.recorded) {
		lines.push(mark("awaiting_approval", `approval needed · prefix ${approval.prefix}`));
	} else if (!approval.valid) {
		lines.push(mark("warning", `approval not valid: ${approval.reasons.join("; ")}`));
	} else if (verbosity !== "minimal") {
		lines.push(mark("success", "approval valid"));
	}

	for (const task of summary.tasks) {
		if (verbosity === "minimal" && task.state === "completed") continue;
		const status = task.blocked ? "blocked" : (TASK_STATE_STATUS[task.state] ?? "warning");
		const detail = task.blocked ? `blocked: ${task.reasons.join("; ")}` : task.state;
		lines.push(`  ${mark(status, `${task.id}  ${task.owner}  ${detail}`)}`);
	}
	const accepted = summary.tasks.filter((task) => task.state === "completed").length;
	lines.push(`${accepted} of ${summary.tasks.length} tasks accepted.`);

	const failure = summary.last_failure;
	if (failure) {
		const requirement = failure.requirement ? ` (${failure.requirement})` : "";
		const attempts = failure.attempts === null ? "" : `, ${failure.attempts} attempt${failure.attempts === 1 ? "" : "s"}`;
		lines.push(mark("error", `last failure: ${failure.task ?? "?"} ${failure.category}${attempts}${requirement}`));
	}

	if (verbosity === "debug") {
		lines.push(theme.muted(`plan digest ${summary.plan_digest}`));
		lines.push(theme.muted(`run directory ${runDir}`));
		lines.push(
			theme.muted(`terminal: colour ${terminal.color ? "on" : "off"}, Unicode ${terminal.unicode ? "on" : "off"}`),
		);
	}
	lines.push(`${theme.bold("Next:")} ${summary.next}`);
	return lines;
}
