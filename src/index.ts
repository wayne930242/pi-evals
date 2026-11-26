/**
 * pi-evals: the live observer, the `/evals` command (status, extract, report, mark), and the `evals_query` tool.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { observe } from "./observer.ts";
import { context, mark, reportPath, runReport, statusText } from "./ops.ts";
import { query, type View, VIEWS } from "./query.ts";

type Env = Record<string, string | undefined>;

/** The CLI to run a back-fill in a child process: the source in a checkout, the build in an installed package. */
export function cliPath(): { cmd: string; args: string[] } | undefined {
	const src = fileURLToPath(new URL("./cli.ts", import.meta.url));
	const dist = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
	const installed = src.includes("/node_modules/");
	const candidates = installed ? [dist] : [src, dist];
	const found = candidates.find((p) => existsSync(p));
	return found ? { cmd: process.execPath, args: [found] } : undefined;
}

const SUBCOMMANDS = ["status", "findings", "extract", "report", "mark"];

function parseFlags(args: string[]) {
	const out: { since?: string; days?: number; project?: string; rest: string[] } = { rest: [] };
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--since") out.since = args[++i];
		else if (args[i] === "--days") out.days = Number(args[++i]);
		else if (args[i] === "--project") out.project = args[++i];
		else out.rest.push(args[i]);
	}
	return out;
}

export function createEvals(options: { env?: Env; spawnExtract?: typeof spawn; now?: () => number } = {}) {
	const env = options.env ?? process.env;
	const spawnFn = options.spawnExtract ?? spawn;
	return function evals(pi: ExtensionAPI): void {
		const ctx0 = context(env);
		observe(pi, { layout: ctx0.layout, home: ctx0.home, now: options.now });
		let settingsWarned = false;
		pi.on("session_start", (_event, ctx) => {
			if (settingsWarned || !ctx0.settings.error) return;
			settingsWarned = true;
			try {
				if (ctx.hasUI) ctx.ui.notify(`pi-evals settings: ${ctx0.settings.error}`, "warning");
			} catch {}
		});
		let running: Promise<void> | undefined;

		const extractInChild = (ctx: ExtensionCommandContext, workers: number): Promise<void> => {
			const cli = cliPath();
			if (!cli) {
				ctx.ui.notify("pi-evals: cannot find its CLI (dist/cli.js); run npm run build in the package.", "error");
				return Promise.resolve();
			}
			return new Promise<void>((resolve) => {
				const child = spawnFn(cli.cmd, [...cli.args, "extract", "--json", "--workers", String(workers)], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
				let buffer = "";
				let last = "";
				let errText = "";
				child.stdout?.on("data", (chunk: Buffer) => {
					buffer += chunk.toString();
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";
					for (const line of lines) {
						try {
							const msg = JSON.parse(line) as { progress?: { done: number; total: number; bytes: number }; result?: { stats: { changed: number; files: number; records: number; mbPerSec: number; failed: number } } };
							if (msg.progress) ctx.ui.setStatus("evals", `evals extract ${msg.progress.done}/${msg.progress.total} files, ${(msg.progress.bytes / 1e9).toFixed(2)} GB`);
							if (msg.result) {
								const s = msg.result.stats;
								last = `pi-evals: extracted ${s.changed} changed of ${s.files} files, ${s.records} records, ${s.mbPerSec} MB/s${s.failed ? `, ${s.failed} failed` : ""}.`;
							}
						} catch {}
					}
				});
				child.stderr?.on("data", (chunk: Buffer) => {
					errText = (errText + chunk.toString()).slice(-600);
				});
				const finish = (code: number | null) => {
					ctx.ui.setStatus("evals", undefined);
					if (code === 0) ctx.ui.notify(last || "pi-evals: extract finished.", "info");
					else ctx.ui.notify(`pi-evals: extract failed (exit ${code}): ${errText.trim()}`, "error");
					resolve();
				};
				child.on("error", (error) => {
					errText = error.message;
					finish(-1);
				});
				child.on("close", finish);
			});
		};

		pi.registerCommand("evals", {
			description: "Usage and process records: /evals [status|findings|extract|report|mark <note>]",
			getArgumentCompletions: (prefix: string) => {
				const items = SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
				return items.length ? items : null;
			},
			handler: async (args, ctx) => {
				const words = args.trim().split(/\s+/).filter(Boolean);
				const sub = words[0] ?? "status";
				if (sub === "status") {
					ctx.ui.notify(statusText(env), "info");
				} else if (sub === "findings") {
					const flags = parseFlags(words.slice(1));
					ctx.ui.notify(query("findings", { env, ...flags }), "info");
				} else if (sub === "extract") {
					if (running) {
						ctx.ui.notify("pi-evals: an extract is already running.", "warning");
						return;
					}
					const workers = words.length === 1 ? 2 : words.length === 3 && words[1] === "--workers" && /^\d+$/.test(words[2]) ? Number(words[2]) : NaN;
					if (!Number.isSafeInteger(workers)) {
						ctx.ui.notify("Usage: /evals extract [--workers <non-negative integer>]", "warning");
						return;
					}
					ctx.ui.notify("pi-evals: extract started in the background; progress shows in the footer.", "info");
					running = extractInChild(ctx, workers).finally(() => {
						running = undefined;
					});
				} else if (sub === "report") {
					const flags = parseFlags(words.slice(1));
					const out = runReport({ env, filter: flags });
					ctx.ui.notify(out ? `pi-evals report: ${out.html}\nmodel: ${out.json}` : "pi-evals: nothing extracted yet; run /evals extract first.", out ? "info" : "warning");
				} else if (sub === "mark") {
					const text = words.slice(1).join(" ").trim();
					if (!text) {
						ctx.ui.notify("Usage: /evals mark <what you changed>", "warning");
						return;
					}
					const change = mark(text, env);
					ctx.ui.notify(`pi-evals: marked ${change.at}: ${text}`, "info");
				} else {
					ctx.ui.notify(`Unknown subcommand "${sub}". Use: ${SUBCOMMANDS.join(", ")}.`, "warning");
				}
			},
		});

		pi.registerTool({
			name: "evals_query",
			label: "Evals Query",
			description: "Start with findings for agent activity and changes; use one detail view for counts, cost or coverage.",
			promptSnippet: "Analyze agent activity: query findings first, then one detail view",
			parameters: Type.Object({
				view: Type.Unsafe<View>({ type: "string", enum: [...VIEWS], description: "Which summary" }),
				since: Type.Optional(Type.String({ description: "YYYY-MM-DD; default last 30 UTC dates through extraction" })),
				project: Type.Optional(Type.String({ description: "Project key, e.g. a repo name" })),
			}),
			async execute(_id, params) {
				const view = params.view as View;
				if (!VIEWS.includes(view)) throw new Error(`Unknown view "${view}". Views: ${VIEWS.join(", ")}.`);
				if (params.since && !/^\d{4}-\d{2}-\d{2}$/.test(params.since)) throw new Error("since must be YYYY-MM-DD.");
				const text = query(view, { since: params.since, project: params.project, env });
				return { content: [{ type: "text", text }], details: { view, report: reportPath(env) } };
			},
		});
	};
}

export default createEvals();
