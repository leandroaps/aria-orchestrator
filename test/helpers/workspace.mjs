// Temporary git repository with an `aria.config.json` and the fixture spec
// `0001-fixture`. No network, no paid model call.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const SPEC = "0001-fixture";

export const CONFIG = {
	version: 1,
	agents: {
		backend: {
			mode: "write",
			category: "implementation",
			allowedPaths: ["src/lib/**", "src/server/**", "src/db/**"],
			defaultVerification: ["node tools/check.mjs"],
		},
		frontend: {
			mode: "write",
			category: "implementation",
			allowedPaths: ["src/app/**", "src/components/**", "!src/app/api/**"],
			defaultVerification: ["node tools/check.mjs"],
		},
		test: {
			mode: "write",
			category: "test",
			allowedPaths: ["e2e/**"],
			defaultVerification: ["node tools/check.mjs"],
		},
		performance: {
			mode: "write",
			category: "implementation",
			allowedPaths: ["src/lib/sub/**"],
			defaultVerification: ["node tools/check.mjs"],
		},
		security: {
			mode: "read-only",
			category: "audit",
			allowedPaths: [],
			defaultVerification: [],
		},
	},
	run: { externalResources: ["neon"] },
};

export const REQUIREMENTS = `# Requirements - Run fixture

**Spec ID:** 0001
**Status:** Approved

- **R1.1** The system does the first thing.
- **R1.2** The system does the second thing.
- **R1.3** The system does the third thing.
`;

function task(id, title, owner, requirement, meta) {
	return `- [ ] **${id}** ${title} (\`${owner}\`) → ${requirement}

  Body of task ${id}.

  \`\`\`yaml task-meta
  id: ${id}
${meta
	.split("\n")
	.map((line) => `  ${line}`)
	.join("\n")}
  \`\`\`
`;
}

const CHECK = "verification:\n  - node tools/check.mjs";

// T1 → T2 on the same territory; T3 writes nothing.
export const TASKS = `# Tasks - Run fixture

**Spec ID:** 0001
**Status:** Approved

${task("T1", "Implement the library", "backend", "R1.1", `depends_on: []\nallowed_paths:\n  - src/lib/**\n${CHECK}`)}
${task("T2", "Use the library", "backend", "R1.2", `depends_on: [T1]\nallowed_paths:\n  - src/lib/**\n${CHECK}`)}
${task("T3", "Task without writes", "backend", "R1.3", `depends_on: []\nallowed_paths: []\n${CHECK}`)}`;

// Owners, territories and resources that exercise the concurrency rules.
export const PARALLEL_TASKS = `# Tasks - Run fixture with parallelism

**Spec ID:** 0001
**Status:** Approved

${task("T1", "Base library", "backend", "R1.1", `depends_on: []\nallowed_paths:\n  - src/lib/**\n${CHECK}`)}
${task("T2", "Library consumer", "backend", "R1.2", `depends_on: [T1]\nallowed_paths:\n  - src/lib/**\n${CHECK}`)}
${task("T3", "Component", "frontend", "R1.1", `depends_on: []\nallowed_paths:\n  - src/components/**\nexclusive_resources:\n  - port:3000\n${CHECK}`)}
${task("T4", "Test on the same port", "test", "R1.1", `depends_on: []\nallowed_paths:\n  - e2e/specs/**\nexclusive_resources:\n  - port:3000\n${CHECK}`)}
${task("T5", "Server, same owner as T1", "backend", "R1.1", `depends_on: []\nallowed_paths:\n  - src/server/**\n${CHECK}`)}
${task("T6", "Page, same owner as T3", "frontend", "R1.1", `depends_on: []\nallowed_paths:\n  - src/app/**\n${CHECK}`)}
${task("T7", "Uses the shared test database", "backend", "R1.1", `depends_on: []\nallowed_paths:\n  - src/db/**\nexclusive_resources:\n  - neon:test\n${CHECK}`)}
${task("T9", "Test in another directory", "test", "R1.1", `depends_on: []\nallowed_paths:\n  - e2e/other/**\n${CHECK}`)}
${task("T10", "Performance inside T1's territory", "performance", "R1.1", `depends_on: []\nallowed_paths:\n  - src/lib/sub/**\n${CHECK}`)}`;

// Fails when src/lib/flag.txt contains FAIL.
const CHECK_SCRIPT = `import { existsSync, readFileSync } from "node:fs";
const flag = "src/lib/flag.txt";
if (existsSync(flag) && readFileSync(flag, "utf8").includes("FAIL")) {
	console.error("fixture check: FAIL");
	process.exit(1);
}
console.log("fixture check: ok");
`;

const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
};

export function git(workspace, args) {
	return execFileSync(
		"git",
		["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args],
		{ cwd: workspace, encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] },
	).trim();
}

export function writeFile(workspace, relativePath, content) {
	const path = join(workspace, relativePath);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

export function createWorkspace({ tasks = TASKS, config = CONFIG } = {}) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "aria-test-")));
	writeFile(dir, "aria.config.json", `${JSON.stringify(config, null, 2)}\n`);
	writeFile(dir, `specs/${SPEC}/requirements.md`, REQUIREMENTS);
	writeFile(dir, `specs/${SPEC}/design.md`, "# Design\n");
	writeFile(dir, `specs/${SPEC}/tasks.md`, tasks);
	writeFile(dir, ".claude/settings.json", '{ "hooks": {} }\n');
	writeFile(dir, "tools/check.mjs", CHECK_SCRIPT);
	writeFile(dir, ".gitignore", ".aria/\nnode_modules/\n");
	writeFile(dir, "src/lib/old.txt", "old\n");
	git(dir, ["init", "-q", "-b", "main"]);
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", "fixture"]);
	return dir;
}

// `node:test` style: `t.after` removes the workspace.
export function workspace(t, options) {
	const dir = createWorkspace(options);
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
