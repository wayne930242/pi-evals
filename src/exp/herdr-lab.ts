/**
 * A run-private Herdr server for dispatch trials: its own HOME, config and socket under a short /tmp directory, so
 * nothing reaches the user's live Herdr. Each trial gets one workspace in it; the main pi runs outside Herdr with
 * that workspace's root pane as its caller pane, and its children open panes beside it. Pane shells get the
 * runner's real HOME back through a wrapper shell, and inherit the server's environment (PI_OFFLINE, PATH).
 */
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface HerdrLab {
	root: string;
	session: string;
	socket: string;
	pid: number;
	bin: string;
}

export interface HerdrWorkspace {
	workspaceId: string;
	paneId: string;
	tabId: string;
}

const XDG = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR"];

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The pane shell: the runner's HOME and XDG variables back, then a plain non-login sh (no user rc files). */
export function paneShell(realHome: string, env: NodeJS.ProcessEnv): string {
	const lines = ["#!/bin/sh", `HOME=${quote(realHome)}; export HOME`];
	for (const k of XDG) lines.push(env[k] === undefined ? `unset ${k}` : `${k}=${quote(env[k] as string)}; export ${k}`);
	lines.push('exec /bin/sh "$@"', "");
	return lines.join("\n");
}

export function labConfig(shell: string): string {
	return [`onboarding = false`, ``, `[terminal]`, `default_shell = ${JSON.stringify(shell)}`, `shell_mode = "non_login"`, ``, `[session]`, `resume_agents_on_restore = false`, ``].join("\n");
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

function cli(lab: Pick<HerdrLab, "bin" | "socket">, args: string[], timeout = 15_000): string {
	// Only the socket path picks the server: the runner's own HERDR_* never reach a lab call.
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("HERDR_")) env[k] = v;
	return execFileSync(lab.bin, args, { env: { ...env, HERDR_SOCKET_PATH: lab.socket }, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Start `herdr --session <name> server` with `serverEnv` (the trial base env: no PI_/HERDR_/SB_ of the runner) plus
 * the lab's HOME, XDG dirs and config. Resolves once the socket answers.
 */
export async function startHerdrLab(options: { id: string; serverEnv: NodeJS.ProcessEnv; bin?: string; realHome?: string }): Promise<HerdrLab> {
	const bin = options.bin ?? "herdr";
	// A Unix socket path must stay under ~104 bytes: /tmp, not the long macOS tmpdir().
	const root = mkdtempSync("/tmp/pe-");
	const home = join(root, "h");
	const session = `pe-${options.id.replace(/[^A-Za-z0-9]/g, "").slice(-12) || "run"}`;
	for (const k of XDG) mkdirSync(join(home, k.toLowerCase()), { recursive: true, mode: 0o700 });
	const shell = join(root, "pane-shell.sh");
	writeFileSync(shell, paneShell(options.realHome ?? homedir(), options.serverEnv));
	chmodSync(shell, 0o755);
	writeFileSync(join(root, "config.toml"), labConfig(shell));
	const env: NodeJS.ProcessEnv = { ...options.serverEnv, HOME: home, HERDR_CONFIG_PATH: join(root, "config.toml") };
	for (const k of XDG) env[k] = join(home, k.toLowerCase());
	for (const k of Object.keys(env)) if (k.startsWith("HERDR_") && k !== "HERDR_CONFIG_PATH") delete env[k];
	const log = openSync(join(root, "server.log"), "a");
	const child = spawn(bin, ["--session", session, "server"], { env, stdio: ["ignore", log, log], detached: true });
	closeSync(log);
	const spawnError = new Promise<Error>((resolve) => child.once("error", resolve));
	child.unref();
	if (child.pid === undefined) throw new Error(`herdr server did not start: ${(await spawnError).message}`);
	// With --session the server puts its socket under its own HOME's config dir, whatever HERDR_SOCKET_PATH says.
	const socket = join(env.XDG_CONFIG_HOME as string, "herdr", "sessions", session, "herdr.sock");
	const fallback = join(home, ".config", "herdr", "sessions", session, "herdr.sock");
	const lab: HerdrLab = { root, session, socket, pid: child.pid, bin };
	for (let i = 0; i < 100; i++) {
		for (const s of [socket, fallback]) {
			if (!existsSync(s)) continue;
			lab.socket = s;
			try {
				cli(lab, ["workspace", "list"], 5_000);
				return lab;
			} catch {}
		}
		if (!alive(child.pid)) break;
		await delay(100);
	}
	await stopHerdrLab(lab);
	throw new Error(`herdr lab server did not answer on ${socket}; see ${join(root, "server.log")}`);
}

export function createWorkspace(lab: HerdrLab, cwd: string, label: string): HerdrWorkspace {
	const out = cli(lab, ["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"]);
	const r = JSON.parse(out)?.result;
	const ws = { workspaceId: r?.workspace?.workspace_id, paneId: r?.root_pane?.pane_id, tabId: r?.root_pane?.tab_id };
	if (![ws.workspaceId, ws.paneId, ws.tabId].every((v) => typeof v === "string" && v)) throw new Error(`unexpected herdr workspace create output: ${out.trim()}`);
	return ws as HerdrWorkspace;
}

/** Close a trial's workspace (its panes and their shells); false when Herdr refused or it was already gone. */
export function closeWorkspace(lab: HerdrLab, workspaceId: string): boolean {
	try {
		cli(lab, ["workspace", "close", workspaceId]);
		return true;
	} catch {
		return false;
	}
}

/** Panes the lab still has in a workspace (or in all), for the end-of-trial check. */
export function paneCount(lab: HerdrLab, workspaceId?: string): number {
	try {
		const out = cli(lab, ["pane", "list", ...(workspaceId ? ["--workspace", workspaceId] : [])]);
		return (JSON.parse(out)?.result?.panes ?? []).length;
	} catch {
		return 0;
	}
}

/** The Herdr identity a trial's main pi gets: caller pane = the workspace's root pane. */
export function herdrEnv(lab: HerdrLab, ws: HerdrWorkspace): Record<string, string> {
	return { HERDR_ENV: "1", HERDR_SOCKET_PATH: lab.socket, HERDR_WORKSPACE_ID: ws.workspaceId, HERDR_PANE_ID: ws.paneId, HERDR_TAB_ID: ws.tabId };
}

/** Stop the server (API, then SIGTERM, then SIGKILL to its group) and remove its root; resolves true when it is gone. */
export async function stopHerdrLab(lab: HerdrLab): Promise<boolean> {
	try {
		cli(lab, ["server", "stop"], 10_000);
	} catch {}
	for (let i = 0; i < 100 && alive(lab.pid); i++) await delay(100);
	for (const signal of ["SIGTERM", "SIGKILL"] as const) {
		if (!alive(lab.pid)) break;
		try {
			process.kill(-lab.pid, signal);
		} catch {}
		for (let i = 0; i < 50 && alive(lab.pid); i++) await delay(100);
	}
	const gone = !alive(lab.pid);
	if (gone) rmSync(lab.root, { recursive: true, force: true });
	return gone;
}

export interface TrialProcessMatch {
	/** An environment entry every pi of the trial starts with (its PI_CODING_AGENT_DIR). */
	env: { key: string; value: string };
	/** The trial's work dir: any process whose cwd is in it belongs to the trial. */
	cwd?: string;
}

function envMatches(needle: string): number[] {
	const pids: number[] = [];
	if (process.platform === "linux") {
		for (const name of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
			try {
				if (readFileSync(`/proc/${name}/environ`, "utf8").split("\0").includes(needle)) pids.push(Number(name));
			} catch {}
		}
		return pids;
	}
	let out = "";
	try {
		// -E appends each process's starting environment; macOS shows it for our own non-platform binaries (node, so pi),
		// not for /bin tools, which the cwd and descendant matches cover.
		out = execFileSync("ps", ["-axww", "-E", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
	} catch {}
	for (const line of out.split("\n")) {
		const at = line.indexOf(` ${needle}`);
		if (at < 0) continue;
		const end = line[at + needle.length + 1];
		if (end !== undefined && end !== " ") continue;
		const pid = Number(line.trim().split(/\s+/)[0]);
		if (Number.isInteger(pid)) pids.push(pid);
	}
	return pids;
}

function cwdMatches(root: string): number[] {
	let real = root;
	try {
		real = realpathSync(root);
	} catch {
		return [];
	}
	const inside = (p: string) => p === real || p.startsWith(`${real}/`);
	const pids: number[] = [];
	if (process.platform === "linux") {
		for (const name of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
			try {
				if (inside(readlinkSync(`/proc/${name}/cwd`))) pids.push(Number(name));
			} catch {}
		}
		return pids;
	}
	let out = "";
	try {
		out = execFileSync("lsof", ["-a", "-d", "cwd", "-Fn", "-w"], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
	} catch (error) {
		out = String((error as { stdout?: unknown }).stdout ?? "");
	}
	let pid = 0;
	for (const line of out.split("\n")) {
		if (line[0] === "p") pid = Number(line.slice(1));
		else if (line[0] === "n" && inside(line.slice(1))) pids.push(pid);
	}
	return pids;
}

/** Every process below the given ones (ppid tree). */
function withDescendants(roots: number[]): number[] {
	let out = "";
	try {
		out = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "ignore"] });
	} catch {}
	const children = new Map<number, number[]>();
	for (const line of out.split("\n")) {
		const [pid, ppid] = line.trim().split(/\s+/).map(Number);
		if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
		children.set(ppid, [...(children.get(ppid) ?? []), pid]);
	}
	const seen = new Set(roots);
	const queue = [...roots];
	while (queue.length) for (const c of children.get(queue.pop() as number) ?? []) if (!seen.has(c)) (seen.add(c), queue.push(c));
	return [...seen];
}

/**
 * This user's processes that belong to a trial: started with its agent dir in their environment (the main, the
 * children), or running in its work dir (their tools, also in a session of their own), and everything below them.
 * Never this process.
 */
export function trialProcesses(match: TrialProcessMatch): number[] {
	const roots = [...envMatches(`${match.env.key}=${match.env.value}`), ...(match.cwd ? cwdMatches(match.cwd) : [])];
	return withDescendants([...new Set(roots)]).filter((pid) => pid !== process.pid && pid > 1).sort((a, b) => a - b);
}

/** SIGTERM, then SIGKILL after `graceMs`, every process of the trial still running; returns how many were found. */
export async function sweepProcesses(match: TrialProcessMatch, graceMs = 5_000): Promise<number> {
	const pids = trialProcesses(match);
	for (const pid of pids) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {}
	}
	if (!pids.length) return 0;
	for (let i = 0; i < graceMs / 100 && pids.some(alive); i++) await delay(100);
	for (const pid of pids.filter(alive)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
	return pids.length;
}
