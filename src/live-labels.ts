/**
 * Labels given in the moment: `/evals label` for the user (a verdict on a process rule, with an optional note in
 * their own words) and the `evals_label` tool for the agent (a correction it was given, names only).
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { appendLabel, cleanNote, itemOnBranch, type LabelRow, type Rule, RULES, ruleLabel, undoLast, VERDICT_META, VERDICTS, type Verdict } from "./labels.ts";
import type { Observed } from "./observer.ts";
import { context } from "./ops.ts";
import { projectKey } from "./project.ts";

type Env = Record<string, string | undefined>;
type Ctx = Pick<ExtensionCommandContext, "cwd" | "sessionManager">;

const VERDICT_WORDS = new Map<string, Verdict>(VERDICTS.flatMap((v) => [[v, v], [VERDICT_META[v].zh, v]] as [string, Verdict][]));
const USAGE = `pi-evals 用法：/evals label（一步步選），或 /evals label <規則> pass|fail|unclear [說明]；規則：${RULES.join("、")}；/evals label undo 撤銷這段工作上一筆當下標記。`;

export function liveLabels(pi: ExtensionAPI, options: { env: Env; now: () => number; observed: Observed }) {
	const { env, now, observed } = options;
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
			if (!rule || !verdict) return say(USAGE, "warning");
		} else {
			if (!ctx.hasUI) return say(USAGE, "warning");
			const cancelled = () => say("pi-evals：已取消，沒有記下標記。");
			const names = RULES.map((r) => ruleLabel(r, "zh"));
			const picked = await ctx.ui.select("要標記哪一條規則？", names);
			rule = RULES[names.indexOf(picked ?? "")];
			if (!rule) return cancelled();
			const verdicts = VERDICTS.map((v) => VERDICT_META[v].zh);
			verdict = VERDICTS[verdicts.indexOf((await ctx.ui.select(`「${ruleLabel(rule, "zh")}」這段工作有照做嗎？`, verdicts)) ?? "")];
			if (!verdict) return cancelled();
			const typed = await ctx.ui.input("補充說明（用你自己的話，可留空，直接按 Enter）", "");
			if (typed === undefined) return cancelled();
			note = typed;
		}
		const row: LabelRow = { session_id: w.session, evaluation_name: rule, label: verdict, at: w.at, annotator: "human", source: "live", item: w.item, project: w.project, note: cleanNote(note) };
		appendLabel(w.file, row);
		say(`pi-evals：已記下「${ruleLabel(rule, "zh")}」${VERDICT_META[verdict].zh}${row.item ? `，進行中的待辦 ${row.item}` : ""}${row.note ? "，附說明" : ""}；/evals label undo 可撤銷。`);
	}

	return { command };
}
