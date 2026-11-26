/**
 * Labels (`labels.jsonl`, append-only): human verdicts on the process checks, given after the fact (`batch`, rows
 * without a source) or in the moment (`live`, `/evals label`), and the corrections an agent logs when the user
 * corrects how it worked (`correction`, the `evals_label` tool). Only a human note is free text; agent rows hold names.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DETECTORS } from "./detectors.ts";
import { DETECTOR_META, type Text } from "./meta.ts";
import { safeName } from "./schema.ts";
import { liveItemKey } from "./work/track.ts";

export const RULES = [...DETECTORS, "other"] as const;
export type Rule = (typeof RULES)[number];
export const VERDICTS = ["pass", "fail", "unclear"] as const;
export type Verdict = (typeof VERDICTS)[number];
export const FAILURE_TYPES = ["no_check_stated", "no_check_run", "skipped_rule", "wrong_order", "unverified_claim", "ignored_instruction", "other"] as const;
export type FailureType = (typeof FAILURE_TYPES)[number];
export type LabelSource = "batch" | "live" | "correction";
export const NOTE_MAX = 500;

const t = (en: string, zh: string): Text => ({ en, zh });
export const RULE_OTHER = t("Other", "其他");
export const VERDICT_META: Record<Verdict, Text> = { pass: t("Followed", "照做"), fail: t("Not followed", "沒照做"), unclear: t("Cannot tell", "看不出來") };
export const FAILURE_TYPE_META: Record<FailureType, Text> = {
	no_check_stated: t("Did not say how to check", "沒先說怎麼驗證"),
	no_check_run: t("Did not run the check", "沒跑檢查"),
	skipped_rule: t("Skipped a rule", "跳過規則"),
	wrong_order: t("Wrong order", "順序錯了"),
	unverified_claim: t("Said done without proof", "沒驗證就說做好了"),
	ignored_instruction: t("Ignored your instruction", "沒照你的指示"),
	other: t("Other", "其他"),
};
export const ruleLabel = (rule: string, lang: "en" | "zh") => (rule === "other" ? RULE_OTHER[lang] : (DETECTOR_META[rule]?.label[lang] ?? rule));

export interface LabelRow {
	session_id: string;
	evaluation_name: string;
	label: Verdict;
	at: string;
	annotator?: "human" | "agent";
	/** Absent on rows written before 0.5.0: those were given after the fact. */
	source?: LabelSource;
	item?: string;
	project?: string;
	/** Skills loaded in the session before the label, for corrections. */
	skills?: string[];
	type?: FailureType;
	note?: string;
	/** A withdrawal of the session's latest live row in effect (`/evals label undo`); holds that row's `at`. */
	undo?: string;
}

export const sourceOf = (row: LabelRow): LabelSource => row.source ?? "batch";
const isLive = (row: LabelRow) => row.source === "live" && row.annotator === "human" && !row.undo;

function parse(file: string): LabelRow[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				const row = JSON.parse(line) as LabelRow;
				return row && typeof row.session_id === "string" ? [row] : [];
			} catch {
				return [];
			}
		});
}

/** Rows in effect, in file order. A withdrawal cancels its session's latest live row still in effect before it. */
export function readLabels(file: string): LabelRow[] {
	const rows = parse(file);
	const gone = new Set<number>();
	const live = new Map<string, number[]>();
	rows.forEach((r, i) => {
		if (r.undo) {
			const last = live.get(r.session_id)?.pop();
			if (last !== undefined) gone.add(last);
			gone.add(i);
		} else if (isLive(r)) live.set(r.session_id, [...(live.get(r.session_id) ?? []), i]);
	});
	return rows.filter((_, i) => !gone.has(i));
}

export function appendLabel(file: string, row: LabelRow): void {
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${JSON.stringify(row)}\n`);
}

/** Withdraws this session's last live label by appending a withdrawal; returns the withdrawn row. */
export function undoLast(file: string, session: string, at: string): LabelRow | undefined {
	const last = readLabels(file).filter((r) => r.session_id === session && isLive(r)).at(-1);
	if (last) appendLabel(file, { session_id: session, evaluation_name: last.evaluation_name, label: last.label, at, annotator: "human", source: "live", undo: last.at });
	return last;
}

/** One line, at most NOTE_MAX characters; empty becomes none. */
export function cleanNote(text: string | undefined): string | undefined {
	const one = (text ?? "").replace(/\s+/g, " ").trim();
	return one ? Array.from(one).slice(0, NOTE_MAX).join("") : undefined;
}

type Entry = { type?: unknown; customType?: unknown; data?: unknown };

/** The work item in progress on the current branch: its 0.4.0 key (uid, else origin#id, else session#id). */
export function itemOnBranch(branch: readonly unknown[] | undefined, session: string): string | undefined {
	if (!branch) return undefined;
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i] as Entry;
		if (e?.type !== "custom" || e.customType !== "todo/v1") continue;
		const tasks = (e.data as { tasks?: unknown })?.tasks;
		if (Array.isArray(tasks)) return liveItemKey(tasks, session);
	}
	return undefined;
}

/** The agent's correction arguments: known names only, nothing else. Throws on any other field or value. */
export function agentLabel(params: unknown): { rule: Rule; type?: FailureType } {
	const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
	const extra = Object.keys(p).filter((k) => k !== "rule" && k !== "type");
	if (extra.length) throw new Error(`evals_label takes only rule and type, not ${extra.map((k) => safeName(k)).join(", ")}.`);
	if (!RULES.includes(p.rule as Rule)) throw new Error(`rule must be one of: ${RULES.join(", ")}.`);
	if (p.type !== undefined && !FAILURE_TYPES.includes(p.type as FailureType)) throw new Error(`type must be one of: ${FAILURE_TYPES.join(", ")}.`);
	return { rule: p.rule as Rule, type: p.type as FailureType | undefined };
}
