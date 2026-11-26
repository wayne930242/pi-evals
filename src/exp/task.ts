/**
 * A suite is a directory: `suite.json` (model, thinking, forbidden paths), `arms/<name>.json` (extensions, skills and
 * system-prompt files added to the bare flags, paths relative to the suite), and `tasks/<id>/` (task.json, prompt.md,
 * prompt.original.md, optional setup.sh, hidden check/, reference).
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
	prompt: string;
}

export interface Arm {
	name: string;
	extensions: string[];
	skills: string[];
	appendSystemPrompt: string[];
}

export interface Suite {
	dir: string;
	model: string;
	thinking: string;
	/** Paths no trial may touch, besides each task's repo and leak_paths. */
	forbidden: string[];
	/** Extensions every arm loads (the todo ledger). */
	extensions: string[];
	arms: Map<string, Arm>;
	tasks: Task[];
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
	const meta = json<{ model?: string; thinking?: string; forbidden?: string[]; extensions?: string[] }>(join(root, "suite.json"));
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
	return { dir: root, model: meta.model, thinking: meta.thinking, forbidden: [...(meta.forbidden ?? []), join(root, "tasks")], extensions: (meta.extensions ?? []).map(abs), arms, tasks };
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
	return { ...raw, dir, prompt: readFileSync(join(dir, "prompt.md"), "utf8") };
}
