// Shared parsing of `<specs>/NNNN-slug/{requirements,design,tasks}.md`.
// Pure reads: nothing here writes a file.
//
// Headings are recognised in English and in Portuguese, the two prompt
// locales the plugin supports.

export const STATUS_CATEGORIES = ["Draft", "Approved", "Implemented", "Superseded"];

const REQUIREMENT_RANGE_PATTERN = /R(\d+)\.(\d+)(?:\s*[–-]\s*R?(\d+)\.(\d+))?/g;
const TASK_START_PATTERN = /^-\s+\[([ xX])\]\s+\*\*(T\d+|TN)\b/;
const HEADING_PATTERN = /^#{1,6}\s/;
const OWNER_PATTERN = /\(`([a-zA-Z][a-zA-Z0-9_-]*)`\)/;
const TASK_META_FENCE_START = /^```ya?ml\s+task-meta\s*$/;
const TASK_META_FENCE_END = /^```\s*$/;
const DEPENDENCY_GRAPH_HEADING = /^##\s+(Dependency graph|Grafo de depend[eê]ncias)/i;
const MANUAL_SECTION_HEADING =
	/^##\s+(Manual\/external verification|Verifica[cç][aã]o manual\/externa)/i;

export function extractHeader(source) {
	const head = source.split("\n").slice(0, 12).join("\n");
	const idMatch = head.match(/\*\*Spec ID:\*\*\s*(\S+)/);
	const statusMatch = head.match(/\*\*Status:\*\*\s*(.+)/);
	const statusText = statusMatch ? statusMatch[1].trim() : null;
	const category = statusText
		? STATUS_CATEGORIES.find((c) => statusText.startsWith(c))
		: null;
	return { id: idMatch ? idMatch[1] : null, statusText, category };
}

// `R1.2`, `R1.2–R1.4` and `R1.2-1.4` all expand to the individual ids.
export function expandRequirementTokens(text) {
	const tokens = new Set();
	let match;
	REQUIREMENT_RANGE_PATTERN.lastIndex = 0;
	while ((match = REQUIREMENT_RANGE_PATTERN.exec(text)) !== null) {
		const [, story, fromMinor, , toMinor] = match;
		const from = Number(fromMinor);
		const to = toMinor !== undefined ? Number(toMinor) : from;
		for (let minor = from; minor <= to; minor += 1) {
			tokens.add(`R${story}.${minor}`);
		}
	}
	return tokens;
}

export function definedRequirements(requirementsSource) {
	const defined = new Set();
	for (const line of requirementsSource.split("\n")) {
		const match = line.match(/^-\s+\*\*(R\d+\.\d+)\*\*/);
		if (match) defined.add(match[1]);
	}
	return defined;
}

// Minimal parser for the ```yaml task-meta block. Not a general YAML parser:
// only scalars, inline lists (`[a, b]`) and one `- item` per line.
function parseTaskMetaBlock(lines) {
	const meta = {};
	let currentKey = null;
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) continue;
		const keyMatch = line.match(/^([a-z_]+):\s*(.*)$/);
		if (keyMatch) {
			const [, key, rest] = keyMatch;
			currentKey = key;
			if (rest) {
				const inline = rest.match(/^\[(.*)\]$/);
				meta[key] = inline
					? inline[1]
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean)
					: rest.trim();
			} else {
				meta[key] = []; // items follow on the next lines, as `- item`
			}
			continue;
		}
		const itemMatch = line.match(/^-\s+(.+)$/);
		if (itemMatch && currentKey) {
			if (!Array.isArray(meta[currentKey])) meta[currentKey] = [];
			meta[currentKey].push(itemMatch[1].trim());
		}
	}
	return meta;
}

// Each task is a block, from its `- [ ] **T#** ...` line to the next task or
// heading: requirement ids may be cited in prose inside the block, not only
// after an arrow on the first line.
export function parseTaskBlocks(tasksSource) {
	const lines = tasksSource.split("\n");
	const tasks = [];
	const manualExceptions = new Set();
	let current = null; // { id, done, textLines, taskMetaLines, inTaskMeta }
	let inManualSection = false;

	const flush = () => {
		if (!current) return;
		const bodyText = current.textLines.join("\n");
		const taskMeta = current.taskMetaLines.length
			? parseTaskMetaBlock(current.taskMetaLines)
			: null;
		tasks.push({
			id: current.id,
			done: current.done,
			owner: taskMeta?.owner ?? (bodyText.match(OWNER_PATTERN) || [])[1] ?? null,
			requirements: expandRequirementTokens(bodyText),
			taskMeta,
			bodyText,
		});
		current = null;
	};

	for (const line of lines) {
		if (MANUAL_SECTION_HEADING.test(line)) {
			flush();
			inManualSection = true;
			continue;
		}
		if (inManualSection) {
			if (HEADING_PATTERN.test(line)) {
				inManualSection = false;
			} else {
				for (const token of expandRequirementTokens(line)) manualExceptions.add(token);
				continue;
			}
		}

		if (current) {
			if (current.inTaskMeta) {
				if (TASK_META_FENCE_END.test(line.trim())) {
					current.inTaskMeta = false;
				} else {
					current.taskMetaLines.push(line);
				}
				continue;
			}
			if (TASK_META_FENCE_START.test(line.trim())) {
				current.inTaskMeta = true;
				continue;
			}
		}

		const taskStart = line.match(TASK_START_PATTERN);
		if (taskStart) {
			flush();
			current = {
				id: taskStart[2],
				done: /[xX]/.test(taskStart[1]),
				textLines: [line],
				taskMetaLines: [],
				inTaskMeta: false,
			};
			continue;
		}
		if (HEADING_PATTERN.test(line)) {
			flush();
			continue;
		}
		if (current) current.textLines.push(line);
	}
	flush();

	return { tasks, manualExceptions };
}

// Best effort: reads the fenced block under `## Dependency graph` (or its
// Portuguese heading), if present, and returns explicit edges — arrows
// (`──►`/`-->`) and a one-level tree (`├──`/`└──`). A merge drawn as a box,
// with no `T#` on the connector line, is not reconstructed; such a task needs
// `depends_on` in its task-meta block.
export function parseDependencyGraphSection(tasksSource) {
	const lines = tasksSource.split("\n");
	const start = lines.findIndex((l) => DEPENDENCY_GRAPH_HEADING.test(l));
	if (start === -1) return null;

	// Only the fenced block counts; prose after it, before the next heading,
	// is not part of the graph even when it cites `T#`.
	let fenceStart = -1;
	let fenceEnd = -1;
	for (let i = start + 1; i < lines.length; i += 1) {
		if (HEADING_PATTERN.test(lines[i])) break;
		if (/^```/.test(lines[i].trim())) {
			if (fenceStart === -1) {
				fenceStart = i;
			} else {
				fenceEnd = i;
				break;
			}
		}
	}
	if (fenceStart === -1 || fenceEnd === -1) return null;
	const block = lines.slice(fenceStart + 1, fenceEnd);
	const edges = new Map(); // taskId -> Set(dependsOn)
	const addEdge = (child, parent) => {
		if (!child || !parent || child === parent) return;
		if (!edges.has(child)) edges.set(child, new Set());
		edges.get(child).add(parent);
	};

	let currentRoot = null;
	for (const rawLine of block) {
		const ids = rawLine.match(/T(?:\d+|N(?![A-Za-z0-9]))/g);
		if (!ids || ids.length === 0) continue;

		if (ids.length > 1) {
			for (let i = 1; i < ids.length; i += 1) addEdge(ids[i], ids[i - 1]);
		}

		const isTreeChild = /^[\s│]*[├└]──/.test(rawLine);
		if (isTreeChild) {
			addEdge(ids[0], currentRoot);
			continue;
		}
		if (ids.length === 1) {
			currentRoot = ids[0];
		}
	}

	const result = {};
	for (const [child, parents] of edges) result[child] = [...parents];
	return result;
}
