/**
 * A suite is a directory: `suite.json` (model, thinking, forbidden paths), `arms/<name>.json` (extensions, skills and
 * system-prompt files added to the bare flags, paths relative to the suite), and `tasks/<id>/` (task.json, prompt.md,
 * prompt.original.md, optional setup.sh, hidden check/, reference). An optional `dispatch` in suite.json makes the trial
 * agent a dispatching main: pi in RPC mode with pi-herdr-agents' `subagent`, its children in a run-private Herdr server.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Kind } from "./grade.ts";

export interface FixtureSource {
	/** A git repository and the commit the agent starts from. */
	repo?: string;
	base?: string;
	/** A later commit added as a second commit "change under review" (review tasks). */
	review?: string;
	/** A directory inside the task, copied as the fixture instead of a repository. */
	dir?: string;
}

export interface Task {
	id: string;
	kind: Kind;
	dir: string;
	source_session?: string;
	fixture: FixtureSource;
	reference: { patch?: string; answer?: string };
	facts?: string[][];
	/** "work": HOME is the trial's work dir (tasks that edit files under ~). */
	home?: "work";
	leak_paths?: string[];
	timeout_min?: number;
	check_timeout_s?: number;
	/** A script in check/ run after the check that writes `$EXP_ARTIFACT_DIR/shot.png`; it never changes the outcome. */
	screenshot?: { script: string; timeout_s?: number };
	prompt: string;
}

export interface Arm {
	name: string;
	extensions: string[];
	skills: string[];
	appendSystemPrompt: string[];
}

/** A dispatching main: the vendored pi-herdr-agents root and the per-trial child caps. */
export interface Dispatch {
	herdrAgents: string;
	/** Children running at once; a launch beyond it is blocked until one finishes. */
	maxConcurrent: number;
	/** Child launches per trial. */
	maxLaunches: number;
}

export interface Suite {
	dir: string;
	model: string;
	thinking: string;
	/** Paths no trial may touch, besides each task's repo and leak_paths. */
	forbidden: string[];
	/** One identical follow-up message sent to every trial after its first run settles (resumes the same session). */
	followUp?: string;
	/** Extensions every arm loads (the todo ledger). */
	extensions: string[];
	arms: Map<string, Arm>;
	tasks: Task[];
	/** Set only for a dispatch suite; single-agent suites run exactly as before. */
	dispatch?: Dispatch;
}

/** The host extension entry inside a pi-herdr-agents checkout. */
export const herdrAgentsEntry = (root: string) => join(root, "pi-extension", "subagents", "index.ts");

function loadDispatch(raw: { herdrAgents?: string; maxConcurrent?: number; maxLaunches?: number }, abs: (p: string) => string, where: string): Dispatch {
	if (!raw.herdrAgents) throw new Error(`${where}: dispatch.herdrAgents is required`);
	const herdrAgents = abs(raw.herdrAgents);
	if (!existsSync(herdrAgentsEntry(herdrAgents))) throw new Error(`${where}: dispatch.herdrAgents has no ${herdrAgentsEntry(herdrAgents)}`);
	const count = (v: number | undefined, fallback: number, name: string) => {
		const n = v ?? fallback;
		if (!Number.isInteger(n) || n < 1) throw new Error(`${where}: dispatch.${name} must be a positive integer`);
		return n;
	};
	return { herdrAgents, maxConcurrent: count(raw.maxConcurrent, 3, "maxConcurrent"), maxLaunches: count(raw.maxLaunches, 8, "maxLaunches") };
}

const KINDS: Kind[] = ["anchor", "light", "should_not"];

function json<T>(file: string): T {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch (error) {
		throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function loadSuite(dir: string): Suite {
	const root = resolve(dir);
	const abs = (p: string) => (isAbsolute(p) ? p : join(root, p));
	const meta = json<{ model?: string; thinking?: string; forbidden?: string[]; extensions?: string[]; followUp?: string; dispatch?: { herdrAgents?: string; maxConcurrent?: number; maxLaunches?: number } }>(join(root, "suite.json"));
	if (!meta.model || !meta.thinking) throw new Error(`${root}/suite.json: model and thinking are required`);
	const arms = new Map<string, Arm>();
	for (const file of readdirSync(join(root, "arms")).filter((f) => f.endsWith(".json")).sort()) {
		const name = file.replace(/\.json$/, "");
		const a = json<Partial<Arm>>(join(root, "arms", file));
		arms.set(name, { name, extensions: (a.extensions ?? []).map(abs), skills: (a.skills ?? []).map(abs), appendSystemPrompt: (a.appendSystemPrompt ?? []).map(abs) });
	}
	const tasksDir = join(root, "tasks");
	const tasks = readdirSync(tasksDir, { withFileTypes: true })
		.filter((d) => d.isDirectory() && existsSync(join(tasksDir, d.name, "task.json")))
		.map((d) => loadTask(join(tasksDir, d.name)))
		.sort((a, b) => a.id.localeCompare(b.id));
	const dispatch = meta.dispatch ? loadDispatch(meta.dispatch, abs, `${root}/suite.json`) : undefined;
	// Children run in Herdr panes whose shells all share one HOME, so a trial cannot give them its own.
	if (dispatch) for (const t of tasks) if (t.home === "work") throw new Error(`${t.dir}/task.json: home "work" is not supported in a dispatch suite`);
	return { dir: root, model: meta.model, thinking: meta.thinking, forbidden: [...(meta.forbidden ?? []), join(root, "tasks")], ...(meta.followUp ? { followUp: meta.followUp } : {}), extensions: (meta.extensions ?? []).map(abs), arms, tasks, ...(dispatch ? { dispatch } : {}) };
}

export function loadTask(dir: string): Task {
	const raw = json<Omit<Task, "dir" | "prompt">>(join(dir, "task.json"));
	const where = `${dir}/task.json`;
	if (!raw.id) throw new Error(`${where}: id is required`);
	if (!KINDS.includes(raw.kind)) throw new Error(`${where}: kind must be one of ${KINDS.join(", ")}`);
	const f = raw.fixture ?? {};
	if (!(f.dir || (f.repo && f.base))) throw new Error(`${where}: fixture needs dir, or repo and base`);
	if (raw.kind === "should_not") {
		if (!raw.facts?.length || !raw.reference?.answer) throw new Error(`${where}: a should_not task needs facts and reference.answer`);
	} else {
		if (!raw.reference?.patch) throw new Error(`${where}: reference.patch is required`);
		if (!existsSync(join(dir, "check", "check.sh"))) throw new Error(`${dir}: check/check.sh is required`);
	}
	if (raw.screenshot) {
		if (raw.kind === "should_not") throw new Error(`${where}: a should_not task cannot take a screenshot`);
		if (!raw.screenshot.script || !existsSync(join(dir, "check", raw.screenshot.script))) throw new Error(`${where}: screenshot.script must name a file in check/`);
	}
	return { ...raw, dir, prompt: readFileSync(join(dir, "prompt.md"), "utf8") };
}
