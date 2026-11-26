/**
 * Labels given in the moment: `/evals label` for the user (a verdict on a process rule, with an optional note in
 * their own words, or just their words for the agent to format) and the `evals_label` tool for the agent (a
 * correction it was given, or the user's words as rows; names only).
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { agentLabel, appendLabel, cleanNote, FAILURE_TYPES, type FailureType, itemOnBranch, type LabelRow, type Rule, RULES, ruleLabel, undoLast, VERDICT_META, VERDICTS, type Verdict } from "./labels.ts";
import type { Observed } from "./observer.ts";
import { context } from "./ops.ts";
import { projectKey } from "./project.ts";

type Env = Record<string, string | undefined>;
type Ctx = Pick<ExtensionCommandContext, "cwd" | "sessionManager">;

const VERDICT_WORDS = new Map<string, Verdict>(VERDICTS.flatMap((v) => [[v, v], [VERDICT_META[v].zh, v]] as [string, Verdict][]));
const USAGE = `pi-evals 用法：/evals label（一步步選）、/evals label <規則> pass|fail|unclear [說明]，或 /evals label <你的話>（交給代理人整理成標記）；規則：${RULES.join("、")}；/evals label undo 撤銷這段工作上一筆當下標記。`;

/** The turn that formats the user's words: the instruction to the agent, with the words last and verbatim. */
export function promptFor(words: string): string {
	return [
		"[/evals label] Below, in the user's own words, is the user's verdict on how this session's work followed the process rules.",
		`Record it with evals_label, once per rule the words judge: on_behalf "user", rule (one of ${RULES.join(", ")}), label as the user judged it (pass, fail or unclear), and type when it is a fail.`,
		"Record only what the user said, add no judgement of your own, then confirm in one line, in plain words and the user's language, what you recorded.",
		"",
		`User's words: ${words}`,
	].join("\n");
}

export function liveLabels(pi: ExtensionAPI, options: { env: Env; now: () => number; observed: Observed }) {
	const { env, now, observed } = options;
	/** The user's words waiting for their turn to start, and the turn that may speak for the user. */
	let waiting: { session: string; prompt: string; note?: string } | undefined;
	let speaking: { session: string; note?: string } | undefined;
	const textOf = (content: unknown) =>
		typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("") : "";
	const start = (text: string | undefined) => {
		if (waiting && text === waiting.prompt) {
			speaking = { session: waiting.session, note: waiting.note };
			waiting = undefined;
		}
	};
	pi.on("before_agent_start", (event) => start((event as { prompt?: string }).prompt));
	// A prompt queued behind a running turn starts its own run without before_agent_start: its user message opens it.
	pi.on("message_end", (event) => {
		const message = (event as { message?: { role?: string; content?: unknown } }).message;
		if (message?.role === "user") start(textOf(message.content));
	});
	pi.on("agent_end", () => {
		speaking = undefined;
	});
	pi.on("session_start", () => {
		waiting = speaking = undefined;
	});
	const where = (ctx: Ctx) => {
		const c = context(env);
		const session = ctx.sessionManager.getSessionId();
		let branch: unknown[] | undefined;
		try {
			branch = ctx.sessionManager.getBranch?.();
		} catch {}
		return { file: c.layout.labels, session, item: itemOnBranch(branch, session), project: projectKey(ctx.cwd, c.home), at: new Date(now()).toISOString() };
	};

	async function command(words: string[], ctx: ExtensionCommandContext): Promise<void> {
		const say = (text: string, level: "info" | "warning" = "info") => ctx.ui.notify(text, level);
		const w = where(ctx);
		if (words[0] === "undo") {
			const last = undoLast(w.file, w.session, w.at);
			say(last ? `pi-evals：已撤銷這段工作上一筆當下標記「${ruleLabel(last.evaluation_name, "zh")}」${VERDICT_META[last.label].zh}。` : "pi-evals：這段工作沒有可撤銷的當下標記。");
			return;
		}
		let rule: Rule | undefined;
		let verdict: Verdict | undefined;
		let note: string | undefined;
		if (words.length) {
			rule = RULES.find((r) => r === words[0]);
			verdict = VERDICT_WORDS.get(words[1] ?? "");
			note = words.slice(2).join(" ");
			if (!rule || !verdict) {
				const text = cleanNote(words.join(" "))!;
				waiting = { session: w.session, prompt: promptFor(text), note: text };
				pi.sendUserMessage(waiting.prompt, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
				return say(`pi-evals：已把你的話交給代理人，請它整理成標記${ctx.isIdle() ? "" : "（等目前的工作告一段落）"}；它會回報記了什麼，不對就用 /evals label undo 撤銷。`);
			}
		} else {
			if (!ctx.hasUI) return say(USAGE, "warning");
			const cancelled = () => say("pi-evals：已取消，沒有記下標記。");
			const names = RULES.map((r) => ruleLabel(r, "zh"));
			const picked = await ctx.ui.select("要標記哪一條規則？", names);
			rule = RULES[names.indexOf(picked ?? "")];
			if (!rule) return cancelled();
			const verdicts = VERDICTS.map((v) => VERDICT_META[v].zh);
			verdict = VERDICTS[verdicts.indexOf((await ctx.ui.select(`這段工作有照做「${ruleLabel(rule, "zh")}」嗎？`, verdicts)) ?? "")];
			if (!verdict) return cancelled();
			const typed = await ctx.ui.input("補充說明（用你自己的話，可留空，直接按 Enter）", "");
			if (typed === undefined) return cancelled();
			note = typed;
		}
		const row: LabelRow = { session_id: w.session, evaluation_name: rule, label: verdict, at: w.at, annotator: "human", source: "live", item: w.item, project: w.project, note: cleanNote(note) };
		appendLabel(w.file, row);
		say(`pi-evals：已記下「${ruleLabel(rule, "zh")}」${VERDICT_META[verdict].zh}${row.item ? `，進行中的待辦 ${row.item}` : ""}${row.note ? "，附說明" : ""}；/evals label undo 可撤銷。`);
	}

	pi.registerTool({
		name: "evals_label",
		label: "Evals Label",
		description: "Log a user's correction of how you worked: rule broken (or other), type of slip; on_behalf user only in a /evals label turn.",
		promptSnippet: "When the user corrects how you worked (skipped a check, wrong order, ignored a rule), log it once",
		parameters: Type.Object(
			{
				rule: Type.Unsafe<Rule>({ type: "string", enum: [...RULES] }),
				label: Type.Optional(Type.Unsafe<Verdict>({ type: "string", enum: [...VERDICTS] })),
				type: Type.Optional(Type.Unsafe<FailureType>({ type: "string", enum: [...FAILURE_TYPES] })),
				on_behalf: Type.Optional(Type.Unsafe<"user">({ type: "string", enum: ["user"] })),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const session = ctx.sessionManager.getSessionId();
			const voice = speaking?.session === session ? speaking : undefined;
			const { rule, label, type, onBehalf } = agentLabel(params, !!voice);
			const w = where(ctx);
			if (onBehalf) {
				// The user's judgement, the agent only formatted it: the note is the user's words, never the agent's.
				appendLabel(w.file, { session_id: w.session, evaluation_name: rule, label, at: w.at, annotator: "human", source: "live-prompt", type, item: w.item, project: w.project, note: voice?.note });
				return { content: [{ type: "text", text: `logged the user's label: ${rule} ${label}${type ? ` (${type})` : ""}` }], details: { rule, label, type, onBehalf } };
			}
			const skills = observed.skills();
			appendLabel(w.file, { session_id: w.session, evaluation_name: rule, label: "fail", at: w.at, annotator: "agent", source: "correction", type, item: w.item, project: w.project, skills: skills.length ? skills : undefined });
			return { content: [{ type: "text", text: `logged correction: ${rule}${type ? ` (${type})` : ""}` }], details: { rule, label, type, onBehalf } };
		},
	});

	return { command };
}
