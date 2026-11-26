/**
 * Drive one dispatching main in `pi --mode rpc` (LF-framed JSONL on stdin/stdout): send the prompt; on each
 * `agent_settled` ask `/exp-busy` whether children are still out; while they are, keep reading (a child's result
 * starts the next turn); once not busy for a short grace, send the suite's follow-up once and wait again; then close
 * stdin and wait for pi to exit. Dialogs are cancelled. The timeout kills the main's process group.
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";

export const BUSY_COMMAND = "/exp-busy";
/** The notify text `/exp-busy` answers with: `exp-busy {"busy":…}`. */
export const BUSY_PREFIX = "exp-busy ";

export interface RpcRun {
	exit: number | null;
	signal: string | null;
	timedOut: boolean;
	followedUp: boolean;
	/** Time spent settled while children were still out. */
	waitedMs: number;
	probes: number;
	/** A command pi refused, or a probe pi did not treat as a command (no exp-dispatch extension). */
	error?: string;
}

export interface RpcOptions {
	bin: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	trialDir: string;
	timeoutMs: number;
	prompt: string;
	followUp?: string;
	/** Quiet time after a not-busy answer before the run counts as finished (a just-delivered result may start a turn). */
	graceMs?: number;
	/** Time pi gets to exit after stdin closes, before it is killed. */
	exitMs?: number;
}

const DIALOGS = new Set(["select", "confirm", "input", "editor"]);

export function runRpc(o: RpcOptions): Promise<RpcRun> {
	return new Promise((resolve, reject) => {
		const child = spawn(o.bin, o.args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
		const events = createWriteStream(join(o.trialDir, "events.jsonl"));
		child.stderr.pipe(createWriteStream(join(o.trialDir, "stderr.txt")));
		const r: RpcRun = { exit: null, signal: null, timedOut: false, followedUp: false, waitedMs: 0, probes: 0 };
		let seq = 0;
		let phase: "first" | "follow" | "closing" = "first";
		let running = false;
		/** The latest probe id; answers to older probes, or probes sent before a new run started, are ignored. */
		let probe: string | undefined;
		let busySince: number | undefined;
		let grace: NodeJS.Timeout | undefined;
		let killTimer: NodeJS.Timeout | undefined;
		const send = (record: Record<string, unknown>) => {
			if (!child.stdin.writable) return;
			child.stdin.write(`${JSON.stringify(record)}\n`);
		};
		const kill = () => {
			for (const [signal, after] of [["SIGTERM", 0], ["SIGKILL", 10_000]] as const) {
				setTimeout(() => {
					try {
						process.kill(-(child.pid as number), signal);
					} catch {}
				}, after).unref();
			}
		};
		const close = () => {
			phase = "closing";
			if (grace) clearTimeout(grace);
			child.stdin.end();
			killTimer = setTimeout(kill, o.exitMs ?? 60_000);
			killTimer.unref();
		};
		const fail = (error: string) => {
			r.error ??= error;
			close();
		};
		const idleDone = () => {
			if (phase === "first" && o.followUp) {
				phase = "follow";
				r.followedUp = true;
				send({ id: `prompt-${++seq}`, type: "prompt", message: o.followUp });
			} else if (phase !== "closing") close();
		};
		const askBusy = () => {
			probe = `busy-${++seq}`;
			r.probes++;
			send({ id: probe, type: "prompt", message: BUSY_COMMAND });
		};
		const onRecord = (rec: Record<string, unknown>) => {
			switch (rec.type) {
				case "agent_start":
					running = true;
					probe = undefined;
					if (grace) clearTimeout(grace);
					grace = undefined;
					if (busySince !== undefined) r.waitedMs += Date.now() - busySince;
					busySince = undefined;
					return;
				case "agent_settled":
					running = false;
					if (phase !== "closing") askBusy();
					return;
				case "response": {
					const id = String(rec.id ?? "");
					if (rec.success === false) return fail(`${rec.command}: ${String(rec.error ?? "refused")}`);
					const disposition = (rec.data as Record<string, unknown> | undefined)?.disposition;
					if (id.startsWith("busy-") && disposition !== "handled") return fail(`${BUSY_COMMAND} was not handled as a command (disposition ${String(disposition)}): the exp-dispatch extension is not loaded`);
					if (id.startsWith("prompt-") && disposition === "handled") idleDone();
					return;
				}
				case "extension_ui_request": {
					if (DIALOGS.has(String(rec.method))) {
						send({ type: "extension_ui_response", id: rec.id, cancelled: true });
						return;
					}
					const message = String(rec.message ?? "");
					if (rec.method !== "notify" || !message.startsWith(BUSY_PREFIX) || probe === undefined || running) return;
					let busy = true;
					try {
						busy = (JSON.parse(message.slice(BUSY_PREFIX.length)) as { busy?: boolean }).busy !== false;
					} catch {}
					probe = undefined;
					if (busy) {
						busySince ??= Date.now();
						return;
					}
					if (busySince !== undefined) r.waitedMs += Date.now() - busySince;
					busySince = undefined;
					if (grace) clearTimeout(grace);
					grace = setTimeout(() => {
						grace = undefined;
						if (!running && phase !== "closing") idleDone();
					}, o.graceMs ?? 3_000);
					return;
				}
			}
		};
		let buffer = "";
		child.stdout.on("data", (chunk: Buffer) => {
			events.write(chunk);
			buffer += chunk.toString("utf8");
			let nl = buffer.indexOf("\n");
			while (nl >= 0) {
				const line = buffer.slice(0, nl).replace(/\r$/, "");
				buffer = buffer.slice(nl + 1);
				nl = buffer.indexOf("\n");
				if (!line.trim()) continue;
				try {
					onRecord(JSON.parse(line) as Record<string, unknown>);
				} catch {}
			}
		});
		child.stdin.on("error", () => {});
		const timer = setTimeout(() => {
			r.timedOut = true;
			if (busySince !== undefined) r.waitedMs += Date.now() - busySince;
			busySince = undefined;
			phase = "closing";
			kill();
		}, o.timeoutMs);
		child.on("error", reject);
		child.on("close", (exit, signal) => {
			clearTimeout(timer);
			if (grace) clearTimeout(grace);
			if (killTimer) clearTimeout(killTimer);
			events.end();
			r.exit = exit;
			r.signal = signal;
			resolve(r);
		});
		send({ id: `prompt-${++seq}`, type: "prompt", message: o.prompt });
	});
}
