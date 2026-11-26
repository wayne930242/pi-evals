/**
 * One trial: clone the fixture into a fresh work dir outside the run dir, run pi headless with the arm's flags and a
 * private agent dir and session dir, then (only after the agent ended) copy the hidden check in and run it, keep the
 * diff, grade, and delete the work dir.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { stateDir } from "../paths.ts";
import { cloneTree, git } from "./fixture.ts";
import { type Efficiency, efficiency, gradeTranscript, readSession, shouldNotOutcome } from "./grade.ts";
import type { Suite, Task } from "./task.ts";

export interface TrialOutcomeRaw {
	exit: number | null;
	signal: string | null;
	timedOut: boolean;
	wallMs: number;
	startedAt: string;
	endedAt: string;
	dirty: boolean;
	checkExit?: number | null;
	checkMs?: number;
	/** The provider refused for quota or rate limit: the run should stop. */
	quota: boolean;
}

export interface TrialRecord {
	task: string;
	kind: Task["kind"];
	arm: string;
	n: number;
	valid: boolean;
	invalid?: string;
	outcome: boolean;
	checkExit?: number | null;
	missingFacts?: string[];
	dirty: boolean;
	process: Record<string, { label: string; explanation: string; value?: number }>;
	editedWhenShouldNot?: boolean;
	leak?: string;
	claimsDone: boolean;
	doneClaimVsOutcome: boolean;
	notices: number;
	timedOut: boolean;
	quota: boolean;
	efficiency: Efficiency;
	session?: string;
	workDir: string;
}

export interface TrialSpec {
	suite: Suite;
	task: Task;
	arm: string;
	n: number;
	runDir: string;
	fixture: string;
	piBin?: string;
	/** pi's auth.json, symlinked into the trial's agent dir so OAuth refresh can write it. */
	authFile?: string;
	tmpRoot?: string;
}

export const trialDirOf = (runDir: string, task: string, arm: string, n: number) => join(runDir, "trials", task, arm, String(n));

const QUOTA = /usage limit|quota|rate.?limit|too many requests|\b429\b/i;

/** Every spelling of a path an agent might type: absolute, `~/…`, `$HOME/…`. */
function spellings(path: string): string[] {
	const home = homedir();
	if (!path.startsWith(`${home}/`)) return [path];
	const rest = path.slice(home.length + 1);
	return [path, `~/${rest}`, `$HOME/${rest}`, `\${HOME}/${rest}`];
}

export function forbiddenFor(suite: Suite, task: Task): string[] {
	const paths = [...suite.forbidden, ...(task.leak_paths ?? []), join(homedir(), ".pi", "agent", "sessions"), join(stateDir(), "experiments")];
	if (task.fixture.repo) paths.push(task.fixture.repo);
	return [...new Set(paths.flatMap(spellings))];
}

export function piArgs(suite: Suite, task: Task, arm: string, sessionDir: string): string[] {
	const a = suite.arms.get(arm);
	if (!a) throw new Error(`unknown arm ${arm}; arms: ${[...suite.arms.keys()].join(", ")}`);
	const args = ["-p", "--mode", "json", "--model", suite.model, "--thinking", suite.thinking, "-ns", "-ne", "-nc", "-np", "--no-mcp", "--no-themes", "-na", "--offline", "--session-dir", sessionDir];
	for (const e of [...suite.extensions, ...a.extensions]) args.push("-e", e);
	for (const s of a.skills) args.push("--skill", s);
	for (const p of a.appendSystemPrompt) args.push("--append-system-prompt", p);
	args.push("--", task.prompt.trim());
	return args;
}

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	// The parent's pi, Herdr and sb session variables must not reach the trial.
	for (const [k, v] of Object.entries(process.env)) if (!/^(?:PI_|HERDR_|SB_|PI$)/.test(k)) env[k] = v;
	return { ...env, ...extra };
}

function findSession(dir: string): string | undefined {
	if (!existsSync(dir)) return undefined;
	for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
		if (entry.isFile() && entry.name.endsWith(".jsonl")) return join(entry.parentPath, entry.name);
	}
	return undefined;
}

function runAgent(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, trialDir: string, timeoutMs: number) {
	return new Promise<{ exit: number | null; signal: string | null; timedOut: boolean }>((resolve, reject) => {
		const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
		child.stdout.pipe(createWriteStream(join(trialDir, "events.jsonl")));
		child.stderr.pipe(createWriteStream(join(trialDir, "stderr.txt")));
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				process.kill(-(child.pid as number), "SIGTERM");
			} catch {}
			setTimeout(() => {
				try {
					process.kill(-(child.pid as number), "SIGKILL");
				} catch {}
			}, 10_000).unref();
		}, timeoutMs);
		child.on("error", reject);
		child.on("close", (exit, signal) => {
			clearTimeout(timer);
			resolve({ exit, signal, timedOut });
		});
	});
}

function runCheck(task: Task, workDir: string, env: NodeJS.ProcessEnv, trialDir: string): { exit: number | null; ms: number } {
	cpSync(join(task.dir, "check"), join(workDir, ".exp-check"), { recursive: true });
	const started = Date.now();
	const r = spawnSync("bash", [join(".exp-check", "check.sh")], { cwd: workDir, env: { ...env, EXP_CHECK_DIR: join(workDir, ".exp-check") }, encoding: "utf8", timeout: (task.check_timeout_s ?? 300) * 1000, maxBuffer: 1 << 26 });
	writeFileSync(join(trialDir, "check.log"), `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}\n` : ""}\nexit ${r.status}\n`);
	return { exit: r.status, ms: Date.now() - started };
}

/** Grade a finished trial from its stored files; rerunnable after a grader fix. */
export function gradeTrial(spec: { suite: Suite; task: Task; arm: string; n: number; trialDir: string; workDir?: string }): TrialRecord {
	const { suite, task, arm, n, trialDir } = spec;
	const raw = JSON.parse(readFileSync(join(trialDir, "outcome.json"), "utf8")) as TrialOutcomeRaw;
	const session = findSession(join(trialDir, "session"));
	const entries = session ? readSession(session) : [];
	const g = gradeTranscript(entries, { kind: task.kind, forbidden: forbiddenFor(suite, task) });
	const eff = efficiency(entries, raw.wallMs);
	let outcome: boolean;
	let missingFacts: string[] | undefined;
	if (task.kind === "should_not") {
		const s = shouldNotOutcome({ finalText: g.finalText, dirty: raw.dirty, edits: g.edits.length, facts: task.facts ?? [] });
		outcome = s.pass;
		missingFacts = s.missing;
	} else outcome = raw.checkExit === 0;
	const invalid = raw.quota ? "quota" : !session ? "no_session" : eff.turns === 0 ? "no_turn" : g.leak ? `leak: ${g.leak}` : undefined;
	const record: TrialRecord = {
		task: task.id,
		kind: task.kind,
		arm,
		n,
		valid: !invalid,
		...(invalid ? { invalid } : {}),
		outcome,
		...(raw.checkExit === undefined ? {} : { checkExit: raw.checkExit }),
		...(missingFacts ? { missingFacts } : {}),
		dirty: raw.dirty,
		process: Object.fromEntries(Object.entries(g.process).map(([k, r]) => [k, { label: r.label, explanation: r.explanation, ...(r.value === undefined ? {} : { value: r.value }) }])),
		...(g.editedWhenShouldNot === undefined ? {} : { editedWhenShouldNot: g.editedWhenShouldNot || raw.dirty }),
		...(g.leak ? { leak: g.leak } : {}),
		claimsDone: g.claimsDone,
		doneClaimVsOutcome: g.claimsDone && !outcome,
		notices: g.notices,
		timedOut: raw.timedOut,
		quota: raw.quota,
		efficiency: eff,
		...(session ? { session } : {}),
		workDir: spec.workDir ?? "",
	};
	writeFileSync(join(trialDir, "grade.json"), `${JSON.stringify(record, null, 2)}\n`);
	return record;
}

export async function runTrial(spec: TrialSpec): Promise<TrialRecord> {
	const { suite, task, arm, n, runDir, fixture } = spec;
	const trialDir = trialDirOf(runDir, task.id, arm, n);
	// An earlier attempt (a leak rerun) is kept beside it, not overwritten.
	if (existsSync(trialDir)) renameSync(trialDir, `${trialDir}.prev-${Date.now()}`);
	mkdirSync(trialDir, { recursive: true });
	const box = mkdtempSync(join(spec.tmpRoot ?? tmpdir(), `pi-evals-trial-${basename(runDir)}-${task.id}-${arm}-${n}-`));
	const workDir = join(box, "work");
	cloneTree(fixture, workDir);
	const fixtureHead = git(workDir, "rev-parse", "HEAD");
	const agentDir = join(trialDir, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), "{}\n");
	if (spec.authFile && existsSync(spec.authFile)) symlinkSync(spec.authFile, join(agentDir, "auth.json"));
	const sessionDir = join(trialDir, "session");
	mkdirSync(sessionDir, { recursive: true });
	const env = cleanEnv({ PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", ...(task.home === "work" ? { HOME: workDir } : {}) });
	const args = piArgs(suite, task, arm, sessionDir);
	writeFileSync(join(trialDir, "command.json"), `${JSON.stringify({ bin: spec.piBin ?? "pi", args, cwd: workDir, home: task.home === "work" ? workDir : undefined }, null, 2)}\n`);
	const startedAt = new Date();
	const r = await runAgent(spec.piBin ?? "pi", args, workDir, env, trialDir, (task.timeout_min ?? 60) * 60_000);
	const endedAt = new Date();
	const dirty = git(workDir, "status", "--porcelain").length > 0 || git(workDir, "rev-parse", "HEAD") !== fixtureHead;
	git(workDir, "add", "-A");
	writeFileSync(join(trialDir, "diff.patch"), execFileSync("git", ["diff", "--cached", "--binary", fixtureHead], { cwd: workDir, maxBuffer: 1 << 28 }));
	const tail = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").slice(-20_000) : "");
	const quota = r.exit !== 0 && QUOTA.test(tail(join(trialDir, "stderr.txt")) + tail(join(trialDir, "events.jsonl")));
	const raw: TrialOutcomeRaw = { exit: r.exit, signal: r.signal, timedOut: r.timedOut, wallMs: endedAt.getTime() - startedAt.getTime(), startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(), dirty, quota };
	if (task.kind !== "should_not") {
		const c = runCheck(task, workDir, cleanEnv(task.home === "work" ? { HOME: workDir } : {}), trialDir);
		raw.checkExit = c.exit;
		raw.checkMs = c.ms;
	}
	writeFileSync(join(trialDir, "outcome.json"), `${JSON.stringify(raw, null, 2)}\n`);
	writeFileSync(join(trialDir, "timing.json"), `${JSON.stringify({ startedAt: raw.startedAt, endedAt: raw.endedAt, wallMs: raw.wallMs, checkMs: raw.checkMs }, null, 2)}\n`);
	const record = gradeTrial({ suite, task, arm, n, trialDir, workDir });
	rmSync(box, { recursive: true, force: true });
	rmSync(join(agentDir, "auth.json"), { force: true });
	return record;
}
