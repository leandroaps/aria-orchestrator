// A stand-in for Claude Code's workflow runtime: it runs a workflow script
// from `workflows/` with the globals the runtime documents (`agent`,
// `pipeline`, `parallel`, `phase`, `log`, `args`), and hands every `agent()`
// call to the test. No module loading, filesystem or shell is given to the
// script, as in the real runtime.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitWorkflow } from "../../lib/workflow-check.mjs";

const AsyncFunction = (async () => {}).constructor;
const WORKFLOWS = join(import.meta.dirname, "..", "..", "workflows");

// `agentImpl(prompt, options)` returns the agent's result, or null for an
// agent that stopped. A throw inside a pipeline stage leaves null in its
// slot, as the runtime does.
export async function runWorkflow(name, args, agentImpl) {
	const split = splitWorkflow(readFileSync(join(WORKFLOWS, `${name}.js`), "utf8"));
	if (split.error) throw new Error(split.error);
	const calls = [];
	const phases = [];
	const logs = [];
	const agent = async (prompt, options = {}) => {
		calls.push({ prompt, ...options });
		return agentImpl(prompt, options);
	};
	const pipeline = async (items, ...stages) => {
		const results = [];
		for (const item of items) {
			try {
				let value = item;
				for (const stage of stages) value = await stage(value);
				results.push(value ?? null);
			} catch {
				results.push(null);
			}
		}
		return results;
	};
	const parallel = (tasks) => Promise.all(tasks.map((task) => (typeof task === "function" ? task() : task)));
	const phase = (title) => phases.push(title);
	const log = (message) => logs.push(message);
	const script = new AsyncFunction("agent", "pipeline", "parallel", "phase", "log", "args", split.body);
	const result = await script(agent, pipeline, parallel, phase, log, args);
	return { meta: split.meta, result, calls, phases, logs };
}
