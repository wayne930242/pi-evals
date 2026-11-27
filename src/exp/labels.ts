/**
 * The boss's label queue for a run: a page listing the flipped trials (the arms disagree on outcome or process, or a
 * done claim met a failed check), blind to the arm and in a seeded random order, and the conversion of the submitted
 * form into `labels.jsonl` rows with `source: "experiment"`. Experiment rows stay out of the monitoring report.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendLabel, type LabelRow, readLabels, type Verdict } from "../labels.ts";
import { readSession, replies } from "./grade.ts";
import type { RunMeta } from "./run.ts";
import { flipped, latestRecords } from "./summary.ts";
import type { TrialRecord } from "./trial.ts";

export interface QueueItem {
	q: string;
	task: string;
	kind: TrialRecord["kind"];
	arm: string;
	n: number;
	session: string;
	sessionId: string;
}

export const OUTCOME = "outcome";
/** The boss's verdict on a trial's screenshot (`exp label --ui`), compared with the verifier's outcome. */
export const UI_OUTCOME = "ui_outcome";
const RULES = ["anchor_before_first_edit", "check_after_last_edit", OUTCOME, UI_OUTCOME] as const;
const VERDICTS = new Set<Verdict>(["pass", "fail", "unclear"]);
const CHOICES = [
	{ value: "pass", label: "照做／做對" },
	{ value: "fail", label: "沒照做／做錯" },
	{ value: "unclear", label: "看不出來" },
];

export function sessionIdOf(file: string): string {
	const first = readFileSync(file, "utf8").split("\n", 1)[0];
	const id = (JSON.parse(first) as { id?: unknown }).id;
	return typeof id === "string" ? id : file;
}

export function shuffle<T>(xs: T[], seed: number): T[] {
	let a = seed >>> 0;
	const random = () => {
		a = (Math.imul(a ^ (a >>> 15), 1 | a) + 0x6d2b79f5) >>> 0;
		return a / 4294967296;
	};
	const out = [...xs];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

type Part = { type?: string; name?: string; arguments?: Record<string, unknown> };

/** The trial's steps, one line per tool call; paths into the vendored arm files are blanked so the arm stays hidden. */
function steps(entries: unknown[]): string[] {
	const out: string[] = [];
	for (const raw of entries) {
		const message = (raw as { type?: string; message?: { role?: string; content?: unknown } }).message;
		if ((raw as { type?: string }).type === "custom_message" && (raw as { customType?: string }).customType === "anchorloop-close-guard") out.push("（收工時出現一則提醒）");
		if (message?.role === "user" && out.length) out.push("（使用者：還有沒做完的就做完）");
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content as Part[]) {
			if (part?.type !== "toolCall") continue;
			const a = part.arguments ?? {};
			const what = String(a.command ?? a.path ?? a.subject ?? a.action ?? "")
				.replace(/\S*\/vendor\/pi-[\w.@-]+\/\S*/g, "（說明文件）")
				.replace(/\s+/g, " ")
				.slice(0, 140);
			out.push(`${part.name}: ${what}`);
		}
	}
	return out;
}

const quote = (s: string) => JSON.stringify(s);

/** Write label-queue.json and label-queue.md (a form page) for the run's flipped trials. */
export function writeLabelQueue(runDir: string, meta: RunMeta, records: TrialRecord[], seed = 20261126): { items: QueueItem[]; page: string } {
	const arms = Object.keys(meta.arms);
	const pair: [string, string] = [arms[0], arms[1]];
	const chosen = shuffle(flipped(latestRecords(records), pair).filter((r) => r.session), seed);
	const items: QueueItem[] = chosen.map((r, i) => ({ q: `q${i + 1}`, task: r.task, kind: r.kind, arm: r.arm, n: r.n, session: r.session as string, sessionId: sessionIdOf(r.session as string) }));
	writeFileSync(join(runDir, "label-queue.json"), `${JSON.stringify(items, null, 2)}\n`);
	const questions: string[] = [];
	for (const item of items) {
		const r = chosen[items.indexOf(item)];
		const entries = readSession(item.session);
		const lines = steps(entries).slice(0, 60).map((s, i) => `${i + 1}. ${s}`);
		const answer = replies(entries).join(" ⏎ ").replace(/\s+/g, " ").slice(0, 900);
		const result = r.kind === "should_not" ? `沒改檔：${r.dirty || r.editedWhenShouldNot ? "否" : "是"}；漏掉的要點：${r.missingFacts?.join("、") || "無"}` : `隱藏檢查：${r.outcome ? "通過" : "失敗"}`;
		const hint = `**${item.task}**（${r.kind}）\n${result}\n${lines.join("\n")}\n**最後回覆：**${answer}`;
		const q = (name: string, label: string, extra: string) => `  - name: ${item.q}_${name}\n    label: ${quote(label)}\n${extra}`;
		const single = (h?: string) => `${h ? `    hint: ${quote(h)}\n` : ""}    required: true\n    other: false\n    choices:\n${CHOICES.map((c) => `      - { value: ${c.value}, label: ${quote(c.label)} }`).join("\n")}`;
		if (r.kind === "should_not") {
			questions.push(q(OUTCOME, `${item.q}　它守住只讀，而且回答到點上嗎？`, single(hint)));
		} else {
			questions.push(q("anchor_before_first_edit", `${item.q}　動手改之前，有先講好怎麼確認改對了嗎？`, single(hint)));
			questions.push(q("check_after_last_edit", `${item.q}　最後一次改完之後，有實際跑過那個檢查嗎？`, single()));
			questions.push(q(OUTCOME, `${item.q}　結果做對了嗎？`, single()));
		}
		questions.push(q("note", `${item.q}　想補一句話嗎？（選填）`, "    type: text"));
	}
	const page = join(runDir, "label-queue.md");
	writeFileSync(
		page,
		[
			`# 實驗標記：${meta.id}`,
			"",
			`這輪有 ${items.length} 次執行的兩組結果不一致，或者說做完了但檢查沒過。順序已打亂，也不標示是哪一組。每題單選，「看不出來」也是正當答案。`,
			"",
			"```form",
			`title: ${quote(`${meta.id} 標記`)}`,
			"submit: 送出標記",
			"questions:",
			...questions,
			"```",
			"",
		].join("\n"),
	);
	return { items, page };
}

/** Parse a submitted form (`- name: value` lines) into experiment label rows and append them. */
export function applyLabelAnswer(runDir: string, meta: RunMeta, answer: string, labelsFile: string, at = new Date().toISOString()): LabelRow[] {
	const items = JSON.parse(readFileSync(join(runDir, "label-queue.json"), "utf8")) as QueueItem[];
	const byQ = new Map(items.map((i) => [i.q, i]));
	const fields = new Map<string, string>();
	let current: string | undefined;
	for (const line of answer.split("\n")) {
		const m = /^- ([A-Za-z0-9_]+): ?(.*)$/.exec(line);
		if (m) {
			current = m[1];
			fields.set(current, m[2]);
		} else if (/^Other comments:/.test(line)) current = undefined;
		else if (current !== undefined && line !== "") fields.set(current, `${fields.get(current)}\n${line}`);
	}
	const rows: LabelRow[] = [];
	for (const [name, raw] of fields) {
		const m = /^(q\d+)_(.+)$/.exec(name);
		const item = m && byQ.get(m[1]);
		if (!m || !item || !(RULES as readonly string[]).includes(m[2]) || m[2] === UI_OUTCOME) continue;
		const label = raw.trim() as Verdict;
		if (!VERDICTS.has(label)) continue;
		const note = fields.get(`${m[1]}_note`)?.trim();
		const row: LabelRow = { session_id: item.sessionId, evaluation_name: m[2], label, at, annotator: "human", source: "experiment", item: `${item.task}/${item.arm}/${item.n}`, project: `exp:${meta.id}`, ...(note && m[2] === OUTCOME ? { note: note.slice(0, 500) } : {}) };
		rows.push(row);
	}
	for (const row of rows) appendLabel(labelsFile, row);
	return rows;
}

/** The boss's experiment labels for this run against the graders, per rule (latest label per trial and rule). */
export function labelAgreement(meta: RunMeta, records: TrialRecord[], labelsFile: string) {
	if (!existsSync(labelsFile)) return [];
	const latest = new Map<string, LabelRow>();
	for (const row of readLabels(labelsFile)) if (row.source === "experiment" && row.project === `exp:${meta.id}`) latest.set(`${row.item}\0${row.evaluation_name}`, row);
	const byItem = new Map(latestRecords(records).map((r) => [`${r.task}/${r.arm}/${r.n}`, r]));
	return RULES.map((rule) => {
		let n = 0, agree = 0, unclear = 0;
		const disagree: string[] = [];
		for (const row of latest.values()) {
			if (row.evaluation_name !== rule) continue;
			const r = byItem.get(row.item ?? "");
			if (!r) continue;
			if (row.label === "unclear") {
				unclear++;
				continue;
			}
			const code = rule === OUTCOME || rule === UI_OUTCOME ? (r.outcome ? "pass" : "fail") : r.process[rule]?.label;
			if (code !== "pass" && code !== "fail") continue;
			n++;
			if (code === row.label) agree++;
			else disagree.push(row.item ?? "");
		}
		return { rule, n, agree, unclear, disagree };
	}).filter((a) => a.n || a.unclear);
}
