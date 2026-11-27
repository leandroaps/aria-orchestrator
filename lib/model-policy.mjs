// The model and reasoning effort of every agent and skill the plugin ships,
// chosen by what each one does, so no step pays for more model than it needs.
// `aria validate contracts` holds the plugin's files to this table; a change
// here is the place to argue a different trade-off.
//
// Agents run on their own model. Skills run on the session's model, so only
// their effort is fixed here; it applies while the skill is the turn's
// active skill.

export const AGENT_POLICY = {
	controller: { model: "haiku", effort: "low" }, // runs one given command, returns its JSON
	presenter: { model: "haiku", effort: "low" }, // mechanical coherence checks
	test: { model: "sonnet", effort: "medium" }, // writes tests from the requirements
	pr: { model: "sonnet", effort: "medium" }, // reviews a diff, writes a description
	security: { model: "opus", effort: "high" }, // the judgement that blocks or allows
};

export const SKILL_POLICY = {
	"follow-run": { effort: "low" }, // one loop tick, mostly one command
	presenter: { effort: "low" },
	"reality-check": { effort: "low" }, // deterministic checks first
	orchestrate: { effort: "medium" }, // the protocol is mostly commands; judgement goes to agents
	interview: { effort: "medium" },
	debugging: { effort: "medium" },
	deprecation: { effort: "medium" },
	"source-grounding": { effort: "medium" },
	"pr-review": { effort: "medium" },
	test: { effort: "medium" },
	spec: { effort: "high" }, // the contract every worker reads
	"doubt-review": { effort: "high" },
	security: { effort: "high" },
};

// The model a workflow's reality check runs on, explicit because the
// built-in Explore agent would otherwise pick its own.
export const REALITY_CHECK = { model: "sonnet", effort: "medium" };
