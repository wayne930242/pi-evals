/**
 * Labels (`labels.jsonl`, append-only): human verdicts on the process checks, given after the fact (`batch`, rows
 * without a source) or in the moment (`live`, `/evals label`), and the corrections an agent logs when the user
 * corrects how it worked (`correction`, the `evals_label` tool). Only a human note is free text; agent rows hold names.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DETECTORS } from "./detectors.ts";
import { DETECTOR_META, type Text } from "./meta.ts";
import { safeName, traceId } from "./schema.ts";
import { liveItemKey } from "./work/track.ts";

export const RULES = [...DETECTORS, "other"] as const;
export type Rule = (typeof RULES)[number];
export const VERDICTS = ["pass", "fail", "unclear"] as const;
export type Verdict = (typeof VERDICTS)[number];
export const FAILURE_TYPES = ["no_check_stated", "no_check_run", "skipped_rule", "wrong_order", "unverified_claim", "ignored_instruction", "other"] as const;
export type FailureType = (typeof FAILURE_TYPES)[number];
/** `live-prompt`: the user's words after `/evals label`, which the agent turned into rows on the user's behalf. */
export type LabelSource = "batch" | "live" | "live-prompt" | "correction";
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

/** A human label given in the moment: typed, or formatted by the agent from the user's words. */
export const givenLive = (row: LabelRow) => row.source === "live" || row.source === "live-prompt";
const isLive = (row: LabelRow) => givenLive(row) && row.annotator === "human" && !row.undo;

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

/**
 * `evals_label` arguments: known names only, nothing else; throws on any other field or value. Without `on_behalf`
 * the row is the agent's own correction, a fail; `on_behalf: "user"` is accepted only while `speaking` (a
 * `/evals label <words>` turn of this session is running), and then needs the user's verdict.
 */
export function agentLabel(params: unknown, speaking: boolean): { rule: Rule; label: Verdict; type?: FailureType; onBehalf: boolean } {
	const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
	const extra = Object.keys(p).filter((k) => !["rule", "label", "type", "on_behalf"].includes(k));
	if (extra.length) throw new Error(`evals_label takes only rule, label, type and on_behalf, not ${extra.map((k) => safeName(k)).join(", ")}.`);
	if (!RULES.includes(p.rule as Rule)) throw new Error(`rule must be one of: ${RULES.join(", ")}.`);
	if (p.type !== undefined && !FAILURE_TYPES.includes(p.type as FailureType)) throw new Error(`type must be one of: ${FAILURE_TYPES.join(", ")}.`);
	if (p.on_behalf !== undefined && p.on_behalf !== "user") throw new Error('on_behalf can only be "user".');
	const onBehalf = p.on_behalf === "user";
	if (onBehalf && !speaking) throw new Error('on_behalf "user" is valid only during a /evals label turn the user started in this session; log your own correction without it.');
	if (onBehalf ? !VERDICTS.includes(p.label as Verdict) : p.label !== undefined && p.label !== "fail") {
		throw new Error(onBehalf ? "label must be the user's verdict: pass, fail or unclear." : "Your own correction is always a fail; a pass or unclear verdict is the user's, given through /evals label.");
	}
	const label = (p.label as Verdict | undefined) ?? "fail";
	if (p.type !== undefined && label !== "fail") throw new Error("type names the kind of slip, so it goes only with a fail.");
	return { rule: p.rule as Rule, label, type: p.type as FailureType | undefined, onBehalf };
}

export interface LabelScope {
	since?: string;
	until?: string;
	project?: string;
	/** Hashed ids (`traceId(id, "labels")`) of the sessions in range, and of every indexed session; absent: no scope. */
	selected?: Set<string>;
	indexed?: Set<string>;
}

const rate = (num: number, den: number) => ({ value: den > 0 ? num / den : null, n: den });
type Count = { n: number; agree: number };
const counted = <K extends string>(map: Map<K, number>) => [...map].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
const bump = <K>(map: Map<K, number>, key: K) => map.set(key, (map.get(key) ?? 0) + 1);

/**
 * Human labels against the code checks (agreement, by when they were given), and the corrections agents logged.
 * A session in the index belongs to the range by its start; a label whose session is not indexed yet (given in the
 * moment, before an extract) belongs by its own time and project.
 */
export function labelsModel(labelsFile: string, evalsFile: string, scope: LabelScope, versionOf: (at: string) => string | undefined) {
	const empty = { present: false, n: 0, unclear: 0, bySource: { batch: 0, live: 0 }, sessions: { batch: 0, live: 0 }, noCode: 0, other: 0, agreement: [] as Agreement[], corrections: corrections([], versionOf) };
	if (!existsSync(labelsFile)) return empty;
	const code = existsSync(evalsFile) ? (JSON.parse(readFileSync(evalsFile, "utf8")) as Record<string, Record<string, string>>) : {};
	const inDates = (at: string) => (!scope.since || at.slice(0, 10) >= scope.since) && (!scope.until || at.slice(0, 10) <= scope.until);
	const inScope = (r: LabelRow) => {
		if (!scope.selected) return true;
		const id = traceId(r.session_id, "labels");
		if (scope.selected.has(id)) return true;
		return r.source !== undefined && !scope.indexed?.has(id) && typeof r.at === "string" && inDates(r.at) && (!scope.project || r.project === scope.project);
	};
	const rows = readLabels(labelsFile).filter(inScope);
	const human = rows.filter((r) => r.annotator !== "agent");
	const by = new Map<string, { unclear: number; batch: Count; live: Count }>();
	const sessions = { batch: new Set<string>(), live: new Set<string>() };
	const out = { ...empty, present: true, n: human.length };
	for (const row of human) {
		const source = givenLive(row) ? "live" : "batch";
		out.bySource[source] += 1;
		sessions[source].add(row.session_id);
		if (row.evaluation_name === "other") {
			out.other += 1;
			continue;
		}
		const t = by.get(row.evaluation_name) ?? { unclear: 0, batch: { n: 0, agree: 0 }, live: { n: 0, agree: 0 } };
		by.set(row.evaluation_name, t);
		// "Cannot tell" is the reader's honest answer, not a disagreement: count it apart from the agreement rate.
		if (row.label === "unclear") {
			out.unclear += 1;
			t.unclear += 1;
			continue;
		}
		const verdict = code[row.session_id]?.[row.evaluation_name];
		if (!verdict || verdict === "na") {
			out.noCode += 1;
			continue;
		}
		t[source].n += 1;
		if (verdict === row.label) t[source].agree += 1;
	}
	out.sessions = { batch: sessions.batch.size, live: sessions.live.size };
	out.agreement = [...by].map(([detector, t]) => {
		const n = t.batch.n + t.live.n, agree = t.batch.agree + t.live.agree;
		return { detector, n, agree, rate: rate(agree, n), unclear: t.unclear, bySource: { batch: { ...t.batch, rate: rate(t.batch.agree, t.batch.n) }, live: { ...t.live, rate: rate(t.live.agree, t.live.n) } } };
	});
	out.corrections = corrections(rows.filter((r) => r.annotator === "agent" && r.source === "correction"), versionOf);
	return out;
}

interface Agreement {
	detector: string;
	n: number;
	agree: number;
	rate: { value: number | null; n: number };
	unclear: number;
	bySource: Record<"batch" | "live", Count & { rate: { value: number | null; n: number } }>;
}

/** The corrections agents logged, by rule, failure type, the skills loaded in the session, and anchorloop version. */
function corrections(rows: LabelRow[], versionOf: (at: string) => string | undefined) {
	const rule = new Map<string, number>(), type = new Map<string, number>(), pair = new Map<string, number>();
	const skill = new Map<string, Set<string>>(), skillN = new Map<string, number>(), version = new Map<string, Set<string>>(), versionN = new Map<string, number>();
	for (const r of rows) {
		const kind = r.type && FAILURE_TYPES.includes(r.type) ? r.type : "other";
		bump(rule, r.evaluation_name);
		bump(type, kind);
		bump(pair, `${r.evaluation_name}|${kind}`);
		for (const s of r.skills?.length ? r.skills : [""]) {
			bump(skillN, s);
			skill.set(s, (skill.get(s) ?? new Set()).add(r.session_id));
		}
		const v = versionOf(r.at) ?? "unknown";
		bump(versionN, v);
		version.set(v, (version.get(v) ?? new Set()).add(r.session_id));
	}
	return {
		n: rows.length,
		sessions: new Set(rows.map((r) => r.session_id)).size,
		byRule: counted(rule).map(([name, n]) => ({ rule: name, n })),
		byType: counted(type).map(([name, n]) => ({ type: name, n })),
		byRuleType: counted(pair).map(([key, n]) => ({ rule: key.split("|")[0], type: key.split("|")[1], n })),
		/** `skill` "" = no skill loaded before the correction. */
		bySkill: counted(skillN).map(([name, n]) => ({ skill: name, n, sessions: skill.get(name)?.size ?? 0 })),
		byVersion: counted(versionN).map(([name, n]) => ({ version: name, n, sessions: version.get(name)?.size ?? 0 })),
	};
}
