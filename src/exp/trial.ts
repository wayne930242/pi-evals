/**
 * One trial: clone the fixture into a fresh work dir outside the run dir, run pi headless with the arm's flags and a
 * private agent dir and session dir, then (only after the agent ended) copy the hidden check in and run it, keep the
 * diff, grade, and delete the work dir.
 *
 * In a dispatch suite the trial agent is a dispatching main: pi in RPC mode driven by `rpc.ts`, with pi-herdr-agents'
 * `subagent` and a workspace of the run's Herdr lab. Its children read the arm from the trial's agent dir
 * (settings.json, APPEND_SYSTEM.md, herdr-agents/config.json) and write their sessions under it; they are graded for
 * leaks, quota refusals and the arm they loaded, and their usage is added to the trial's.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir } from "../paths.ts";
import { cloneTree, git } from "./fixture.ts";
import { type Efficiency, efficiency, findLeak, gradeTranscript, readSession, shouldNotOutcome } from "./grade.ts";
import { closeWorkspace, createWorkspace, type HerdrLab, herdrEnv, sweepProcesses, trialProcesses } from "./herdr-lab.ts";
import { runRpc } from "./rpc.ts";
import { type Arm, herdrAgentsEntry, type Suite, type Task } from "./task.ts";

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
	/** The suite's follow-up turn ran. */
	followedUp?: boolean;
	/** Dispatch trials only: what the RPC driver and the cleanup saw. */
	dispatch?: DispatchRaw;
}

export interface DispatchRaw {
	/** Time the main sat settled while children were still out. */
	waitedMs: number;
	probes: number;
	workspaceClosed: boolean;
	/** Processes of this trial still running after the main ended and its workspace closed (killed by the sweep). */
	leftover: number;
	/** Processes of this trial alive after the sweep: should be 0. */
	aliveAfter: number;
	error?: string;
}

/** What a session actually loaded, stamped by exp-dispatch.ts before its first run. */
export interface ArmStamp {
	role?: string;
	skills: string[];
	tools: string[];
	appendChars: number;
	appendSha: string;
}

export interface ChildRecord {
	session: string;
	name?: string;
	agent?: string;
	model?: string;
	turns: number;
	toolCalls: number;
	tokens: number;
	cost: number;
	wallMs: number;
	armStamp?: ArmStamp;
	leak?: string;
}

export interface DispatchRecord {
	launches: number;
	blocked: number;
	/** Child results that reached the main's transcript. */
	results: number;
	maxConcurrentSeen: number;
	waitedMs: number;
	leftover: number;
	aliveAfter: number;
	workspaceClosed: boolean;
	/** `subagent` and `subagent_resume` calls the main made. */
	calls: number;
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
	/** Dispatch trials only: the children's usage summed, and main plus children. `efficiency` stays the main's. */
	childEfficiency?: Efficiency;
	totalEfficiency?: Efficiency;
	children?: ChildRecord[];
	dispatch?: DispatchRecord;
	armStamp?: ArmStamp;
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
	/** The run's Herdr lab; required for a dispatch suite. */
	herdr?: HerdrLab;
}

export const trialDirOf = (runDir: string, task: string, arm: string, n: number) => join(runDir, "trials", task, arm, String(n));

const QUOTA = /usage limit|quota|rate.?limit|too many requests|\b429\b/i;

/** Every spelling of a path an agent might type: absolute, `~/…`, `$HOME/…` (absolute only when HOME is the trial's). */
function spellings(path: string, ownHome: boolean): string[] {
	const home = homedir();
	if (ownHome || !path.startsWith(`${home}/`)) return [path];
	const rest = path.slice(home.length + 1);
	return [path, `~/${rest}`, `$HOME/${rest}`, `\${HOME}/${rest}`];
}

export function forbiddenFor(suite: Suite, task: Task): string[] {
	const paths = [...suite.forbidden, ...(task.leak_paths ?? []), join(homedir(), ".pi", "agent", "sessions"), join(stateDir(), "experiments")];
	if (task.fixture.repo) paths.push(task.fixture.repo);
	return [...new Set(paths.flatMap((p) => spellings(p, task.home === "work")))];
}

/** The headless pi command line; `session` resumes that session file (the follow-up turn) instead of starting one. */
export function piArgs(suite: Suite, task: Task, arm: string, sessionDir: string, followUp?: { session: string; prompt: string }): string[] {
	const a = suite.arms.get(arm);
	if (!a) throw new Error(`unknown arm ${arm}; arms: ${[...suite.arms.keys()].join(", ")}`);
	const args = ["-p", "--mode", "json", "--model", suite.model, "--thinking", suite.thinking, "-ns", "-ne", "-nc", "-np", "--no-mcp", "--no-themes", "-na", "--offline", "--session-dir", sessionDir];
	if (followUp) args.push("--session", followUp.session);
	for (const e of [...suite.extensions, ...a.extensions]) args.push("-e", e);
	for (const s of a.skills) args.push("--skill", s);
	for (const p of a.appendSystemPrompt) args.push("--append-system-prompt", p);
	args.push("--", followUp ? followUp.prompt : task.prompt.trim());
	return args;
}

/** exp-dispatch.ts next to this module: the source in a checkout, the build in dist. */
export const expDispatchPath = () => fileURLToPath(new URL(`./dispatch-ext/exp-dispatch${extname(fileURLToPath(import.meta.url))}`, import.meta.url));

const armOf = (suite: Suite, arm: string): Arm => {
	const a = suite.arms.get(arm);
	if (!a) throw new Error(`unknown arm ${arm}; arms: ${[...suite.arms.keys()].join(", ")}`);
	return a;
};

/**
 * The dispatching main's command line: RPC mode (the prompt goes over stdin), astra as the only model in scope (the
 * scope is what children may be launched with), the host extension and exp-dispatch.ts, then the suite and arm
 * resources. No --append-system-prompt and no -nc: the arm's prompt comes from APPEND_SYSTEM.md, as for the children,
 * and main and children both read the work dir's AGENTS.md.
 */
export function dispatchArgs(suite: Suite, arm: string, sessionDir: string): string[] {
	if (!suite.dispatch) throw new Error(`${suite.dir} is not a dispatch suite`);
	const a = armOf(suite, arm);
	const args = ["--mode", "rpc", "--model", suite.model, "--models", suite.model, "--thinking", suite.thinking, "-ns", "-ne", "-np", "--no-mcp", "--no-themes", "-na", "--offline", "--session-dir", sessionDir];
	args.push("-e", herdrAgentsEntry(suite.dispatch.herdrAgents), "-e", expDispatchPath());
	for (const e of [...suite.extensions, ...a.extensions]) args.push("-e", e);
	for (const s of a.skills) args.push("--skill", s);
	return args;
}

const TASK_CATEGORIES = ["coding", "complex-coding", "review", "recon", "qa", "architecture", "docs"];

/** The trial agent dir a dispatch trial's children start from: the same arm as the main, the suite's model only. */
export function dispatchAgentFiles(suite: Suite, arm: string): Record<string, string> {
	if (!suite.dispatch) throw new Error(`${suite.dir} is not a dispatch suite`);
	const a = armOf(suite, arm);
	const settings = {
		extensions: ["-builtin:mcp", "-builtin:tool-search", "-builtin:codemode", "-builtin:llama.cpp", ...suite.extensions, ...a.extensions, expDispatchPath()],
		// Children run without -ns, and pi always discovers the user's ~/.agents/skills: exclude them, as -ns does for the main.
		skills: [...a.skills, `!${join(homedir(), ".agents", "skills")}/**`],
		defaultProjectTrust: "never",
	};
	const config = {
		herdr: { backend: "legacy" },
		models: {
			default: suite.model,
			agents: {},
			tasks: Object.fromEntries(TASK_CATEGORIES.map((c) => [c, [suite.model]])),
			tasksThinking: Object.fromEntries(TASK_CATEGORIES.map((c) => [c, suite.thinking])),
		},
		spawning: { maxDepth: 1 },
		persistent: { maxAgents: 1 },
		guidelines: { launchRoster: false },
		outcomeLedger: true,
	};
	const files: Record<string, string> = {
		"settings.json": `${JSON.stringify(settings, null, 2)}\n`,
		"herdr-agents/config.json": `${JSON.stringify(config, null, 2)}\n`,
	};
	if (a.appendSystemPrompt.length) files["APPEND_SYSTEM.md"] = `${a.appendSystemPrompt.map((p) => readFileSync(p, "utf8").trim()).join("\n\n")}\n`;
	return files;
}

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	// The parent's pi, Herdr and sb session variables must not reach the trial.
	for (const [k, v] of Object.entries(process.env)) if (!/^(?:PI_|HERDR_|SB_|PI$)/.test(k)) env[k] = v;
	return { ...env, ...extra };
}

/** The executable a bare command name resolves to on PATH, or undefined. */
function which(name: string, path = process.env.PATH ?? ""): string | undefined {
	if (name.includes("/")) return existsSync(name) ? resolvePath(name) : undefined;
	for (const dir of path.split(":").filter(Boolean)) if (existsSync(join(dir, name))) return join(dir, name);
	return undefined;
}

/**
 * The environment of a dispatch run's Herdr server, which its pane shells and so every child inherit: the trial base
 * env (no PI_/HERDR_/SB_ of the runner), PI_OFFLINE, and a PATH whose first entry holds the pi the main runs (children
 * are always started as a bare `pi`; a wrapper not named pi does not reach them).
 */
export function labEnv(piBin?: string): NodeJS.ProcessEnv {
	const env = cleanEnv({ PI_OFFLINE: "1" });
	const pi = which(piBin ?? "pi", env.PATH);
	if (pi && basename(pi) === "pi") env.PATH = [dirname(pi), env.PATH].filter(Boolean).join(":");
	return env;
}

/** The trial's own session: a file at the top of the session dir (pi-herdr-agents keeps child artifacts below it). */
export function findSession(dir: string): string | undefined {
	if (!existsSync(dir)) return undefined;
	const top = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => e.name).sort();
	if (top.length) return join(dir, top[0]);
	for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
		if (entry.isFile() && entry.name.endsWith(".jsonl") && !join(entry.parentPath, entry.name).slice(dir.length).split("/").includes("artifacts")) return join(entry.parentPath, entry.name);
	}
	return undefined;
}

/** Every child session of a dispatch trial: `<trial>/agent/sessions/<cwd-dir>/*.jsonl`. */
export function childSessions(trialDir: string): string[] {
	const root = join(trialDir, "agent", "sessions");
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true, recursive: true })
		.filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
		.map((e) => join(e.parentPath, e.name))
		.sort();
}

type Raw = { type?: string; customType?: string; data?: unknown; timestamp?: string; message?: { role?: string; toolName?: string; toolCallId?: string; isError?: boolean; details?: Record<string, unknown>; content?: unknown; stopReason?: string; errorMessage?: string } };

/** The last custom entry of a type (exp-dispatch.ts appends one per change). */
function lastCustom<T>(entries: unknown[], type: string): T | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as Raw;
		if (e?.type === "custom" && e.customType === type) return e.data as T;
	}
	return undefined;
}

/** A provider refusal for quota or rate limit recorded in a session (RPC mode exits 0 after one). */
export function quotaInSession(entries: unknown[]): boolean {
	return entries.some((raw) => {
		const m = (raw as Raw)?.message;
		return (raw as Raw)?.type === "message" && m?.role === "assistant" && typeof m.errorMessage === "string" && QUOTA.test(m.errorMessage);
	});
}

function sessionWallMs(entries: unknown[]): number {
	const times = entries.map((e) => Date.parse(String((e as Raw)?.timestamp ?? ""))).filter((t) => Number.isFinite(t));
	return times.length ? Math.max(...times) - Math.min(...times) : 0;
}

export function sumEfficiency(list: Efficiency[]): Efficiency {
	const e: Efficiency = { wallMs: 0, turns: 0, toolCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const x of list) for (const k of Object.keys(e) as (keyof Efficiency)[]) e[k] += x[k];
	e.cost = Math.round(e.cost * 1e6) / 1e6;
	return e;
}

/** Launch calls the main made, by child session file (from the tool results' details). */
function launches(entries: unknown[]): { calls: number; bySession: Map<string, { name?: string; agent?: string; model?: string }> } {
	const bySession = new Map<string, { name?: string; agent?: string; model?: string }>();
	let calls = 0;
	for (const raw of entries) {
		const m = (raw as Raw)?.message;
		if ((raw as Raw)?.type !== "message" || m?.role !== "toolResult" || (m.toolName !== "subagent" && m.toolName !== "subagent_resume")) continue;
		calls++;
		const d = m.details ?? {};
		if (typeof d.sessionFile === "string") bySession.set(d.sessionFile, { name: d.name as string | undefined, agent: d.agent as string | undefined, model: d.model as string | undefined });
	}
	return { calls, bySession };
}

/** Why a session's stamp does not show the arm (main: the arm's own resources; child: the same as its main). */
export function stampMismatch(arm: Arm, main: ArmStamp | undefined, child?: ArmStamp | null): string | undefined {
	if (!main) return "main has no arm stamp";
	if (child === undefined) {
		if ((arm.appendSystemPrompt.length > 0) !== (main.appendChars > 0)) return `main ${main.appendChars ? "has" : "lacks"} the appended system prompt`;
		if ((arm.skills.length > 0) !== (main.skills.length > 0)) return `main ${main.skills.length ? "has" : "lacks"} skills`;
		return undefined;
	}
	if (!child) return "no arm stamp";
	if (child.appendSha !== main.appendSha) return "appended system prompt differs from the main's";
	if (child.skills.join() !== main.skills.join()) return `skills differ from the main's (${child.skills.length} vs ${main.skills.length})`;
	return undefined;
}

function gradeChildren(trialDir: string, mainEntries: unknown[], forbidden: string[]): { children: ChildRecord[]; effs: Efficiency[]; quota: boolean; calls: number } {
	const { calls, bySession } = launches(mainEntries);
	let quota = false;
	const children = childSessions(trialDir).map((file) => {
		const entries = readSession(file);
		const eff = efficiency(entries, sessionWallMs(entries));
		if (quotaInSession(entries)) quota = true;
		const who = bySession.get(file) ?? [...bySession.entries()].find(([k]) => basename(k) === basename(file))?.[1] ?? {};
		const stamp = lastCustom<ArmStamp>(entries, "exp-arm-stamp");
		const leak = findLeak(entries, forbidden);
		const child: ChildRecord = {
			session: file,
			...(who.name ? { name: who.name } : {}),
			...(who.agent ? { agent: who.agent } : {}),
			...(who.model ? { model: who.model } : {}),
			turns: eff.turns,
			toolCalls: eff.toolCalls,
			tokens: eff.input + eff.output + eff.cacheRead + eff.cacheWrite,
			cost: eff.cost,
			wallMs: eff.wallMs,
			...(stamp ? { armStamp: stamp } : {}),
			...(leak ? { leak } : {}),
		};
		return { child, eff };
	});
	return { children: children.map((c) => c.child), effs: children.map((c) => c.eff), quota, calls };
}

function runAgent(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, trialDir: string, timeoutMs: number, suffix = "") {
	return new Promise<{ exit: number | null; signal: string | null; timedOut: boolean }>((resolve, reject) => {
		const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
		child.stdout.pipe(createWriteStream(join(trialDir, `events${suffix}.jsonl`)));
		child.stderr.pipe(createWriteStream(join(trialDir, `stderr${suffix}.txt`)));
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
	// Dispatch trials: children graded for leaks, quota and arm; their usage added to the trial's.
	let dispatch: Pick<TrialRecord, "children" | "childEfficiency" | "totalEfficiency" | "dispatch" | "armStamp"> = {};
	let childLeak: string | undefined;
	let mismatch: string | undefined;
	let quota = raw.quota;
	if (suite.dispatch) {
		const graded = gradeChildren(trialDir, entries, forbiddenFor(suite, task));
		const children = graded.children;
		const childEfficiency = sumEfficiency(graded.effs);
		const stats = lastCustom<{ launches?: number; blocked?: number; results?: number; maxConcurrentSeen?: number }>(entries, "exp-dispatch") ?? {};
		const main = lastCustom<ArmStamp>(entries, "exp-arm-stamp");
		const a = armOf(suite, arm);
		const leaky = children.find((c) => c.leak);
		if (leaky) childLeak = `child ${leaky.name ?? basename(leaky.session)}: ${leaky.leak}`;
		mismatch = stampMismatch(a, main) ?? children.map((c) => {
			const why = stampMismatch(a, main, c.armStamp ?? null);
			return why ? `child ${c.name ?? basename(c.session)}: ${why}` : undefined;
		}).find(Boolean);
		quota = quota || graded.quota || quotaInSession(entries);
		const d = raw.dispatch;
		dispatch = {
			children,
			childEfficiency,
			totalEfficiency: { ...sumEfficiency([eff, childEfficiency]), wallMs: eff.wallMs + childEfficiency.wallMs },
			dispatch: {
				launches: stats.launches ?? 0,
				blocked: stats.blocked ?? 0,
				results: stats.results ?? 0,
				maxConcurrentSeen: stats.maxConcurrentSeen ?? 0,
				waitedMs: d?.waitedMs ?? 0,
				leftover: d?.leftover ?? 0,
				aliveAfter: d?.aliveAfter ?? 0,
				workspaceClosed: d?.workspaceClosed ?? false,
				calls: graded.calls,
			},
			...(main ? { armStamp: main } : {}),
		};
	}
	const leak = g.leak ?? childLeak;
	const invalid = quota ? "quota" : !session ? "no_session" : eff.turns === 0 ? "no_turn" : leak ? `leak: ${leak}` : mismatch ? `arm_mismatch: ${mismatch}` : raw.dispatch?.error ? `rpc: ${raw.dispatch.error}` : undefined;
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
		...(leak ? { leak } : {}),
		claimsDone: g.claimsDone,
		doneClaimVsOutcome: g.claimsDone && !outcome,
		notices: g.notices,
		timedOut: raw.timedOut,
		quota,
		efficiency: eff,
		...dispatch,
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
	if (suite.dispatch) {
		for (const [name, content] of Object.entries(dispatchAgentFiles(suite, arm))) {
			mkdirSync(join(agentDir, name, ".."), { recursive: true });
			writeFileSync(join(agentDir, name), content);
		}
	} else writeFileSync(join(agentDir, "settings.json"), "{}\n");
	if (spec.authFile && existsSync(spec.authFile)) symlinkSync(spec.authFile, join(agentDir, "auth.json"));
	const sessionDir = join(trialDir, "session");
	mkdirSync(sessionDir, { recursive: true });
	const startedAt = new Date();
	const timeoutMs = (task.timeout_min ?? 60) * 60_000;
	let r: { exit: number | null; signal: string | null; timedOut: boolean };
	let followedUp = false;
	let dispatchRaw: DispatchRaw | undefined;
	if (suite.dispatch) {
		const lab = spec.herdr;
		if (!lab) throw new Error("a dispatch suite needs the run's Herdr lab");
		const ws = createWorkspace(lab, workDir, `${task.id}-${arm}-${n}`);
		const env = cleanEnv({ PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", EXP_DISPATCH_MAX_CONCURRENT: String(suite.dispatch.maxConcurrent), EXP_DISPATCH_MAX_LAUNCHES: String(suite.dispatch.maxLaunches), ...herdrEnv(lab, ws) });
		const args = dispatchArgs(suite, arm, sessionDir);
		writeFileSync(join(trialDir, "command.json"), `${JSON.stringify({ bin: spec.piBin ?? "pi", args, cwd: workDir, mode: "rpc", herdr: { session: lab.session, ...ws } }, null, 2)}\n`);
		const rr = await runRpc({ bin: spec.piBin ?? "pi", args, cwd: workDir, env, trialDir, timeoutMs, prompt: task.prompt.trim(), followUp: suite.followUp });
		// Children run in Herdr panes, outside the main's process group: close the workspace, then sweep whatever
		// still carries this trial's agent dir (a child's tool process in its own session survives the pane).
		const workspaceClosed = closeWorkspace(lab, ws.workspaceId);
		const mine = { env: { key: "PI_CODING_AGENT_DIR", value: agentDir }, cwd: workDir };
		const leftover = await sweepProcesses(mine);
		r = { exit: rr.exit, signal: rr.signal, timedOut: rr.timedOut };
		followedUp = rr.followedUp;
		dispatchRaw = { waitedMs: rr.waitedMs, probes: rr.probes, workspaceClosed, leftover, aliveAfter: trialProcesses(mine).length, ...(rr.error ? { error: rr.error } : {}) };
	} else {
		const env = cleanEnv({ PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", ...(task.home === "work" ? { HOME: workDir } : {}) });
		const args = piArgs(suite, task, arm, sessionDir);
		writeFileSync(join(trialDir, "command.json"), `${JSON.stringify({ bin: spec.piBin ?? "pi", args, cwd: workDir, home: task.home === "work" ? workDir : undefined }, null, 2)}\n`);
		r = await runAgent(spec.piBin ?? "pi", args, workDir, env, trialDir, timeoutMs);
		// One identical follow-up turn in every arm, so a close-guard notice left at settle can be read and acted on.
		const first = findSession(sessionDir);
		if (suite.followUp && first && r.exit === 0 && !r.timedOut) {
			const more = piArgs(suite, task, arm, sessionDir, { session: first, prompt: suite.followUp });
			r = await runAgent(spec.piBin ?? "pi", more, workDir, env, trialDir, Math.max(60_000, timeoutMs - (Date.now() - startedAt.getTime())), "-2");
			followedUp = true;
		}
	}
	const endedAt = new Date();
	const dirty = git(workDir, "status", "--porcelain").length > 0 || git(workDir, "rev-parse", "HEAD") !== fixtureHead;
	git(workDir, "add", "-A");
	writeFileSync(join(trialDir, "diff.patch"), execFileSync("git", ["diff", "--cached", "--binary", fixtureHead], { cwd: workDir, maxBuffer: 1 << 28 }));
	const tail = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").slice(-20_000) : "");
	const suffix = followedUp && !suite.dispatch ? "-2" : "";
	// RPC mode exits 0 after a provider refusal, so a dispatch trial also reads the refusal from the sessions.
	const mainSession = suite.dispatch ? findSession(sessionDir) : undefined;
	const quota = suite.dispatch
		? (mainSession ? quotaInSession(readSession(mainSession)) : false) || childSessions(trialDir).some((f) => quotaInSession(readSession(f))) || (r.exit !== 0 && QUOTA.test(tail(join(trialDir, "stderr.txt"))))
		: r.exit !== 0 && QUOTA.test(tail(join(trialDir, `stderr${suffix}.txt`)) + tail(join(trialDir, `events${suffix}.jsonl`)));
	const raw: TrialOutcomeRaw = { exit: r.exit, signal: r.signal, timedOut: r.timedOut, wallMs: endedAt.getTime() - startedAt.getTime(), startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(), dirty, quota, followedUp, ...(dispatchRaw ? { dispatch: dispatchRaw } : {}) };
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
