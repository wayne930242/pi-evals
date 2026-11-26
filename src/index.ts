/**
 * pi-evals: the live observer, the `/evals` command (status, extract, report, mark, label, run), `/ask-ai`, and the `evals_query` and `evals_label` tools.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { askAi } from "./ask-ai.ts";
import { scriptsDir } from "./findings.ts";
import { liveLabels } from "./live-labels.ts";
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

const SUBCOMMANDS = ["status", "findings", "extract", "report", "mark", "label", "run"];

/** The shipped analysis scripts (`scripts/<name>.mjs`) `/evals run` offers, with what each is for. */
export const SCRIPTS: Record<string, string> = {
	freshness: "索引是不是最新的：最後擷取時間、各擷取器版本的摘要數；版本混雜時數字不能看",
	disagree: "某條規則上程式判定和你的標記哪裡不一致，逐段列出，看偏哪一邊（用法：disagree <規則> [--range 天數]）",
	"by-version": "某項檢查在各套件版本下的通過率（用法：by-version <檢查> [--pkg 套件]）",
	sample: "分層抽樣還沒標過的工作段，給你手動標記（只有 id 與屬性）（用法：sample <數量> [--since 時間] [--seed 數字]）",
	"label-import": "把填好的標記表單答案寫進 labels.jsonl（用法：label-import <答案檔> [--sample 樣本檔]）",
	"session-shape": "一段工作的結構軌跡：檢查看到的事件順序，不含訊息內容（用法：session-shape <session id>）",
	"change-impact": "某次調整前後的數字（用法：change-impact <時間或 sha> [套件或種類]）",
	"skill-days": "某個 skill 每天被載入的工作段數（用法：skill-days <skill> [專案]）",
	"package-errors": "某個套件每天的工具出錯數（用法：package-errors <套件> [專案]）",
};

/** Runs one shipped script with the session's environment; resolves with its exit code and output. */
function runScript(name: string, args: string[], env: Env): Promise<{ code: number | null; out: string }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [fileURLToPath(new URL(`../scripts/${name}.mjs`, import.meta.url)), ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout?.on("data", (c: Buffer) => void (out += c.toString()));
		child.stderr?.on("data", (c: Buffer) => void (out += c.toString()));
		child.on("error", (error) => resolve({ code: -1, out: error.message }));
		child.on("close", (code) => resolve({ code, out: out.trim() }));
	});
}

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
		const observed = observe(pi, { layout: ctx0.layout, home: ctx0.home, now: options.now });
		const labels = liveLabels(pi, { env, now: options.now ?? Date.now, observed });
		askAi(pi, { env, now: options.now ?? Date.now });
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
			description: "Usage and process records: /evals [status|findings|extract|report|mark <note>|label|run <script>]",
			getArgumentCompletions: (prefix: string) => {
				if (prefix.startsWith("run ")) {
					const names = Object.keys(SCRIPTS).filter((n) => n.startsWith(prefix.slice(4)));
					return names.length ? names.map((n) => ({ value: `run ${n}`, label: n, description: SCRIPTS[n] })) : null;
				}
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
				} else if (sub === "label") {
					await labels.command(words.slice(1), ctx);
				} else if (sub === "run") {
					const name = words[1];
					if (!name) {
						ctx.ui.notify(`pi-evals scripts (/evals run <script> [args]):\n${Object.entries(SCRIPTS).map(([n, what]) => `${n}　${what}`).join("\n")}`, "info");
						return;
					}
					if (!Object.hasOwn(SCRIPTS, name)) {
						ctx.ui.notify(`Unknown script "${name}". /evals run lists them.`, "warning");
						return;
					}
					const { code, out } = await runScript(name, words.slice(2), env);
					ctx.ui.notify(out || `${name}: no output (exit ${code})`, code === 0 ? "info" : "warning");
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
				return { content: [{ type: "text", text }], details: { view, scriptsDir, report: reportPath(env) } };
			},
		});
	};
}

export default createEvals();
