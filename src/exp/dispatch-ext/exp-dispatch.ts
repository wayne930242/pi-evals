/**
 * Loaded into every session of a dispatch trial (main and children). Experiment plumbing only, never in live pi.
 *
 * Every session: before its first run, appends an `exp-arm-stamp` entry with the skills, tools and appended system
 * prompt it actually loaded, so the grader can tell a child that did not get its arm.
 *
 * The main only (PI_SUBAGENT_ID unset):
 * - `/exp-busy` answers the harness with a notify `exp-busy {"busy":…}`: busy while pi-herdr-agents reports working
 *   children (its `child-busy` probe) or a launched child's result has not reached the transcript yet.
 * - `subagent`/`subagent_resume` calls are blocked with a worktree, as persistent, with a cwd outside the trial's
 *   work dir, at `EXP_DISPATCH_MAX_CONCURRENT` children out, or after `EXP_DISPATCH_MAX_LAUNCHES` launches.
 * - Each change to the counts appends an `exp-dispatch` entry (launches, blocked, results, maxConcurrentSeen).
 */
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const STAMP_TYPE = "exp-arm-stamp";
export const DISPATCH_TYPE = "exp-dispatch";
export const BLOCK_PREFIX = "exp-dispatch:";
const CHILD_BUSY_CHANNEL = "pi-herdr-agents:child-busy";
const LAUNCH_TOOLS = new Set(["subagent", "subagent_resume"]);

const positive = (v: string | undefined, fallback: number) => {
	const n = Number(v);
	return Number.isInteger(n) && n > 0 ? n : fallback;
};

export default function expDispatch(pi: ExtensionAPI) {
	let stamped = false;
	pi.on("before_agent_start", (event) => {
		if (stamped) return;
		stamped = true;
		const options = (event as { systemPromptOptions?: { skills?: { name?: string }[]; appendSystemPrompt?: string; selectedTools?: string[] } }).systemPromptOptions;
		const append = (options?.appendSystemPrompt ?? "").trim();
		pi.appendEntry(STAMP_TYPE, {
			role: process.env.PI_SUBAGENT_ID ? "child" : "main",
			skills: (options?.skills ?? []).map((s) => String(s?.name ?? "")).filter(Boolean).sort(),
			tools: [...(options?.selectedTools ?? pi.getActiveTools())].sort(),
			appendChars: append.length,
			appendSha: append ? createHash("sha256").update(append).digest("hex").slice(0, 16) : "",
		});
	});
	if (process.env.PI_SUBAGENT_ID) return;

	const maxConcurrent = positive(process.env.EXP_DISPATCH_MAX_CONCURRENT, 3);
	const maxLaunches = positive(process.env.EXP_DISPATCH_MAX_LAUNCHES, 8);
	const stats = { launches: 0, blocked: 0, results: 0, maxConcurrentSeen: 0 };
	/** Calls that passed the guard and have not ended yet (sibling calls in one message are preflighted first). */
	const reserved = new Set<string>();
	type Ctx = { sessionManager: { getEntries(): unknown[] } };
	/** Results already in the transcript: the authority for "delivered", whatever event order pi uses. */
	const delivered = (ctx: Ctx) => ctx.sessionManager.getEntries().filter((e) => (e as { type?: string; customType?: string })?.type === "custom_message" && (e as { customType?: string }).customType === "subagent_result").length;
	const out = (ctx: Ctx) => {
		stats.results = delivered(ctx);
		return Math.max(0, stats.launches - stats.results);
	};
	const record = () => pi.appendEntry(DISPATCH_TYPE, { ...stats });

	pi.registerCommand("exp-busy", {
		description: "pi-evals experiment: are children still out?",
		handler: async (_args, ctx) => {
			const probe = { busy: false };
			pi.events.emit(CHILD_BUSY_CHANNEL, probe);
			const n = out(ctx);
			ctx.ui.notify(`exp-busy ${JSON.stringify({ busy: probe.busy || n > 0 || reserved.size > 0, working: probe.busy, out: n })}`, "info");
		},
	});

	pi.on("tool_call", (event, ctx) => {
		if (!LAUNCH_TOOLS.has(event.toolName)) return;
		const input = (event.input ?? {}) as { worktree?: unknown; persistent?: unknown; cwd?: unknown };
		const block = (why: string) => {
			stats.blocked++;
			record();
			return { block: true, reason: `${BLOCK_PREFIX} ${why}` };
		};
		if (input.worktree) return block("worktrees are not available in this experiment; launch an ordinary child in the work dir.");
		if (input.persistent === true) return block("persistent children are not available in this experiment.");
		if (typeof input.cwd === "string" && input.cwd) {
			const rel = relative(ctx.cwd, resolve(ctx.cwd, input.cwd));
			if (rel.startsWith("..") || isAbsolute(rel)) return block("a child's cwd must stay inside the work dir.");
		}
		if (stats.launches + reserved.size >= maxLaunches) return block(`the launch limit (${maxLaunches}) is reached; finish with the children you have.`);
		if (out(ctx) + reserved.size >= maxConcurrent) return block(`${maxConcurrent} children are already running; wait for a running child's result before launching another.`);
		reserved.add(event.toolCallId);
	});

	// Every call that passed the guard ends here, also when another extension blocked it after this one.
	pi.on("tool_execution_end", (event, ctx) => {
		if (!reserved.delete(event.toolCallId)) return;
		const details = (event.result as { details?: { error?: unknown } } | undefined)?.details;
		if (event.isError || details?.error !== undefined) return;
		stats.launches++;
		stats.maxConcurrentSeen = Math.max(stats.maxConcurrentSeen, out(ctx));
		record();
	});

	pi.on("agent_settled", (_event, ctx) => {
		const before = stats.results;
		out(ctx);
		if (stats.results !== before) record();
	});
}
