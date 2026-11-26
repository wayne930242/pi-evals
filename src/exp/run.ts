/**
 * A run: every chosen task × arm × k trials, interleaved per task (A1 B1 A2 B2 …) so a run stopped early stays paired,
 * at most `parallel` at once. A leaking trial is rerun once. The first quota refusal stops new trials.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { stateDir } from "../paths.ts";
import { buildFixture } from "./fixture.ts";
import { type HerdrLab, startHerdrLab, stopHerdrLab } from "./herdr-lab.ts";
import { summarize } from "./summary.ts";
import { loadSuite, type Suite, type Task } from "./task.ts";
import { gradeTrial, labEnv, runTrial, type TrialRecord, trialDirOf } from "./trial.ts";

export const experimentsDir = (env: NodeJS.ProcessEnv = process.env) => join(stateDir(env), "experiments");
export const fixturesDir = (env: NodeJS.ProcessEnv = process.env) => join(stateDir(env), "fixtures");

export interface RunOptions {
	suiteDir: string;
	arms: string[];
	k: number;
	tasks?: string[];
	parallel?: number;
	runId?: string;
	piBin?: string;
	/** The herdr binary a dispatch suite's lab server runs (default `herdr` on PATH). */
	herdrBin?: string;
	/** Rerun the chosen tasks in an existing run, with this reason: their earlier trials are superseded, not deleted. */
	rerun?: string;
	onProgress?: (event: Record<string, unknown>) => void;
}

export interface RunMeta {
	id: string;
	suite: string;
	suiteSha?: string;
	arms: Record<string, { extensions: string[]; skills: string[]; appendSystemPrompt: string[] }>;
	extensions: string[];
	model: string;
	thinking: string;
	followUp?: string;
	/** Dispatch suites: the main's child caps and the pi-herdr-agents it loads. */
	dispatch?: { herdrAgents: string; maxConcurrent: number; maxLaunches: number; herdr?: string };
	pi?: string;
	k: number;
	tasks: string[];
	host: string;
	parallel: number;
	startedAt: string;
	endedAt?: string;
	stopped?: string;
	/** Tasks rerun in this run after a task fix; the superseded trials stay in results.jsonl and as `<n>.prev-*` dirs. */
	reruns?: { tasks: string[]; reason: string; at: string; suiteSha?: string }[];
}

const safe = (f: () => string) => {
	try {
		return f();
	} catch {
		return undefined;
	}
};

export function selectTasks(suite: Suite, ids?: string[]): Task[] {
	if (!ids?.length) return suite.tasks;
	const unknown = ids.filter((id) => !suite.tasks.some((t) => t.id === id));
	if (unknown.length) throw new Error(`unknown task ${unknown.join(", ")}; tasks: ${suite.tasks.map((t) => t.id).join(", ")}`);
	return suite.tasks.filter((t) => ids.includes(t.id));
}

export function readResults(runDir: string): TrialRecord[] {
	const file = join(runDir, "results.jsonl");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as TrialRecord);
}

export function readRun(runDir: string): RunMeta {
	return JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as RunMeta;
}

export function writeSummary(runDir: string, meta: RunMeta) {
	const summary = summarize(readResults(runDir), Object.keys(meta.arms), { k: meta.k });
	writeFileSync(join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
	return summary;
}

export async function runExperiment(options: RunOptions): Promise<{ runDir: string; records: TrialRecord[]; stopped?: string }> {
	const suite = loadSuite(options.suiteDir);
	for (const arm of options.arms) if (!suite.arms.has(arm)) throw new Error(`unknown arm ${arm}; arms: ${[...suite.arms.keys()].join(", ")}`);
	const tasks = selectTasks(suite, options.tasks);
	const id = options.runId ?? new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
	const runDir = join(experimentsDir(), id);
	mkdirSync(runDir, { recursive: true });
	const parallel = Math.max(1, options.parallel ?? 3);
	const meta: RunMeta = {
		id,
		suite: suite.dir,
		suiteSha: safe(() => execFileSync("git", ["-C", suite.dir, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()),
		arms: Object.fromEntries(options.arms.map((a) => {
			const arm = suite.arms.get(a)!;
			return [a, { extensions: arm.extensions, skills: arm.skills, appendSystemPrompt: arm.appendSystemPrompt }];
		})),
		extensions: suite.extensions,
		model: suite.model,
		thinking: suite.thinking,
		...(suite.followUp ? { followUp: suite.followUp } : {}),
		...(suite.dispatch ? { dispatch: { ...suite.dispatch, herdr: safe(() => execFileSync(options.herdrBin ?? "herdr", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()) } } : {}),
		pi: safe(() => execFileSync(options.piBin ?? "pi", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()),
		k: options.k,
		tasks: tasks.map((t) => t.id),
		host: hostname(),
		parallel,
		startedAt: new Date().toISOString(),
	};
	let record = meta;
	if (options.rerun !== undefined) {
		if (!existsSync(join(runDir, "run.json"))) throw new Error(`no run ${id} to rerun tasks in`);
		const old = readRun(runDir);
		const same = old.model === meta.model && old.thinking === meta.thinking && old.k === meta.k && Object.keys(old.arms).join() === Object.keys(meta.arms).join();
		if (!same) throw new Error(`rerun must match run ${id}: model ${old.model}/${old.thinking}, arms ${Object.keys(old.arms).join(",")}, k ${old.k}; got k ${meta.k}`);
		record = { ...old, tasks: [...new Set([...old.tasks, ...meta.tasks])], reruns: [...(old.reruns ?? []), { tasks: meta.tasks, reason: options.rerun, at: meta.startedAt, ...(meta.suiteSha ? { suiteSha: meta.suiteSha } : {}) }] };
	}
	writeFileSync(join(runDir, "run.json"), `${JSON.stringify(record, null, 2)}\n`);
	const progress = options.onProgress ?? (() => {});
	const fixtures = new Map<string, string>();
	for (const task of tasks) {
		progress({ fixture: task.id });
		fixtures.set(task.id, buildFixture(suite, task, fixturesDir(), { log: (line) => progress({ log: line }) }));
	}
	const jobs: { task: Task; arm: string; n: number }[] = [];
	for (const task of tasks) for (let n = 1; n <= options.k; n++) for (const arm of options.arms) jobs.push({ task, arm, n });
	const done = new Set(options.rerun === undefined ? readResults(runDir).filter((r) => r.valid).map((r) => `${r.task}\0${r.arm}\0${r.n}`) : []);
	const queue = jobs.filter((j) => !done.has(`${j.task.id}\0${j.arm}\0${j.n}`));
	const total = jobs.length;
	let finished = jobs.length - queue.length;
	let stopped: string | undefined;
	const records: TrialRecord[] = [];
	const authFile = join(homedir(), ".pi", "agent", "auth.json");
	// One Herdr server per run for a dispatch suite; each trial gets a workspace in it.
	let herdr: HerdrLab | undefined;
	if (suite.dispatch && queue.length) {
		herdr = await startHerdrLab({ id, serverEnv: labEnv(options.piBin), bin: options.herdrBin });
		progress({ herdr: { session: herdr.session, socket: herdr.socket, pid: herdr.pid } });
	}
	const one = async (job: (typeof jobs)[number]) => {
		const spec = { suite, task: job.task, arm: job.arm, n: job.n, runDir, fixture: fixtures.get(job.task.id)!, piBin: options.piBin, authFile, herdr };
		let record = await runTrial(spec);
		if (!record.valid && record.leak && !stopped) {
			progress({ rerun: `${job.task.id}/${job.arm}/${job.n}`, reason: record.invalid });
			appendFileSync(join(runDir, "results.jsonl"), `${JSON.stringify(record)}\n`);
			record = await runTrial(spec);
		}
		if (record.quota) stopped = `quota refusal in ${job.task.id}/${job.arm}/${job.n}`;
		// pi that wrote no session did not start (a bad flag, a missing extension file): every later trial would fail too.
		else if (record.invalid === "no_session") stopped = `pi wrote no session in ${job.task.id}/${job.arm}/${job.n}; see its stderr.txt`;
		appendFileSync(join(runDir, "results.jsonl"), `${JSON.stringify(record)}\n`);
		records.push(record);
		finished++;
		progress({ progress: { done: finished, total }, trial: `${job.task.id}/${job.arm}/${job.n}`, outcome: record.outcome, valid: record.valid, cost: (record.totalEfficiency ?? record.efficiency).cost, minutes: Math.round(record.efficiency.wallMs / 6000) / 10, ...(record.children ? { children: record.children.length } : {}) });
	};
	const workers = Array.from({ length: Math.min(parallel, queue.length) }, async () => {
		while (queue.length && !stopped) await one(queue.shift()!);
	});
	try {
		await Promise.all(workers);
	} finally {
		if (herdr) progress({ herdrStopped: await stopHerdrLab(herdr) });
	}
	if (options.rerun === undefined) record.endedAt = new Date().toISOString();
	if (stopped) record.stopped = stopped;
	writeFileSync(join(runDir, "run.json"), `${JSON.stringify(record, null, 2)}\n`);
	writeSummary(runDir, record);
	if (stopped) progress({ monitorOutcome: { status: "blocked", message: stopped } });
	return { runDir, records, stopped };
}

/** Regrade every stored trial of a run (after a grader fix); rewrites results.jsonl and summary.json. */
export function regradeRun(runDir: string): TrialRecord[] {
	const meta = readRun(runDir);
	const suite = loadSuite(meta.suite);
	const records: TrialRecord[] = [];
	for (const task of selectTasks(suite, meta.tasks)) {
		for (const arm of Object.keys(meta.arms)) {
			for (let n = 1; n <= meta.k; n++) {
				const trialDir = trialDirOf(runDir, task.id, arm, n);
				if (existsSync(join(trialDir, "outcome.json"))) records.push(gradeTrial({ suite, task, arm, n, trialDir }));
			}
		}
	}
	writeFileSync(join(runDir, "results.jsonl"), records.map((r) => `${JSON.stringify(r)}\n`).join(""));
	writeSummary(runDir, meta);
	return records;
}
