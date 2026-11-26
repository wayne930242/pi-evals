/** Where pi-evals reads and writes: pi's agent dir, its own state dir, and its settings. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Settings {
	/** Extra session roots read by extract, e.g. a retention trash dir. */
	extraRoots: string[];
	/** Repositories whose git history feeds the change timeline. */
	changeRepos: string[];
	/** Sessions inactive for longer than this count as old in the coverage figure. */
	coverageDays: number;
	/** Days on each side of a change in the before/after comparison. */
	impactWindowDays: number;
}

type Env = Record<string, string | undefined>;

export const home = (env: Env = process.env) => env.HOME || homedir();

export function agentDir(env: Env = process.env): string {
	return env.PI_CODING_AGENT_DIR ? resolve(env.PI_CODING_AGENT_DIR) : join(home(env), ".pi", "agent");
}

export function stateDir(env: Env = process.env): string {
	if (env.PI_EVALS_STATE_DIR) return resolve(env.PI_EVALS_STATE_DIR);
	const base = env.XDG_STATE_HOME ? resolve(env.XDG_STATE_HOME) : join(home(env), ".local", "state");
	return join(base, "pi-evals");
}

export function settingsFile(env: Env = process.env): string {
	const base = env.XDG_CONFIG_HOME ? resolve(env.XDG_CONFIG_HOME) : join(home(env), ".config");
	return join(base, "pi-evals", "settings.json");
}

export function defaultSettings(env: Env = process.env): Settings {
	const projects = join(home(env), "projects");
	return {
		extraRoots: [],
		changeRepos: [join(projects, "weihung-basic-agent"), join(projects, "weihung-agent-root")],
		coverageDays: 60,
		impactWindowDays: 7,
	};
}

const expand = (path: string, env: Env) => (path === "~" || path.startsWith("~/") ? join(home(env), path.slice(1)) : resolve(path));

/**
 * Settings file merged over the defaults; `PI_EVALS_ROOTS` (path-list) adds roots. A file that cannot be read or parsed
 * yields the defaults and an `error` the caller shows, so a typo never stops the observer from loading.
 */
export function loadSettings(env: Env = process.env): Settings & { error?: string } {
	const settings: Settings & { error?: string } = defaultSettings(env);
	const file = settingsFile(env);
	let raw: Partial<Settings> | undefined;
	if (existsSync(file)) {
		try {
			raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Settings>;
		} catch (error) {
			settings.error = `${file}: ${error instanceof Error ? error.message : String(error)}; using defaults`;
		}
	}
	if (raw) {
		if (Array.isArray(raw.extraRoots)) settings.extraRoots = raw.extraRoots.map((p) => expand(String(p), env));
		if (Array.isArray(raw.changeRepos)) settings.changeRepos = raw.changeRepos.map((p) => expand(String(p), env));
		if (typeof raw.coverageDays === "number" && raw.coverageDays > 0) settings.coverageDays = raw.coverageDays;
		if (typeof raw.impactWindowDays === "number" && raw.impactWindowDays > 0) settings.impactWindowDays = raw.impactWindowDays;
	}
	if (env.PI_EVALS_ROOTS) settings.extraRoots.push(...env.PI_EVALS_ROOTS.split(":").filter(Boolean).map((p) => expand(p, env)));
	return settings;
}

export interface Layout {
	state: string;
	/** Live observer records, one file per UTC day. */
	events: string;
	/** Back-fill records, one file per source session. */
	records: string;
	checkpoint: string;
	days: string;
	sessionRows: string;
	sessionEvals: string;
	changes: string;
	marks: string;
	labels: string;
	status: string;
	reports: string;
}

export function layout(state = stateDir()): Layout {
	return {
		state,
		events: join(state, "events"),
		records: join(state, "index", "records"),
		checkpoint: join(state, "index", "checkpoint.json"),
		days: join(state, "index", "days.json"),
		sessionRows: join(state, "index", "sessions.json"),
		sessionEvals: join(state, "index", "session-evals.json"),
		changes: join(state, "changes.jsonl"),
		marks: join(state, "marks.jsonl"),
		labels: join(state, "labels.jsonl"),
		status: join(state, "index", "status.json"),
		reports: join(state, "reports"),
	};
}

/** UTC day of an epoch-ms or ISO time. */
export const dayOf = (t: number | string): string => new Date(t).toISOString().slice(0, 10);
