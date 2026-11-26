/** Additive per-day aggregates. A session summary holds one per UTC day; the index sums them by day and project. */
import type { DetectorName, NoticeKind } from "./detectors.ts";
import type { Label } from "./schema.ts";

export interface ToolAgg {
	calls: number;
	errors: number;
	durSum: number;
	durN: number;
}

/** Upper bounds (ms) of the ask-user wait buckets; the last bucket is open. */
export const ASK_BUCKETS = [10_000, 30_000, 60_000, 300_000, 1_800_000];

export interface DayAgg {
	sessions: number;
	subagentSessions: number;
	prompts: number;
	tools: Record<string, ToolAgg>;
	skills: Record<string, number>;
	skillTriggers: Record<string, number>;
	/** Sessions (by start day) that loaded the skill, and their total cost. */
	skillSessions: Record<string, number>;
	skillCost: Record<string, number>;
	ask: { calls: number; cancelled: number; errors: number; durSum: number; durN: number; buckets: number[]; sources: Record<string, number> };
	monitors: { started: number; finished: number; statuses: Record<string, number>; durSum: number; durN: number };
	/** Subagent launches by `role|model`. */
	subagents: Record<string, number>;
	/** Cost and sessions of subagent sessions by the role their parent gave them (filled when the index links them). */
	subagentCost: Record<string, number>;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; calls: number };
	models: Record<string, number>;
	detectors: Record<string, { pass: number; fail: number; na: number }>;
	/** Detector results by anchorloop version: `detector|version` (filled by the index). */
	detectorVersions: Record<string, { pass: number; fail: number; na: number }>;
	notices: Record<string, number>;
	compactions: number;
}

export function emptyDay(): DayAgg {
	return {
		sessions: 0,
		subagentSessions: 0,
		prompts: 0,
		tools: {},
		skills: {},
		skillTriggers: {},
		skillSessions: {},
		skillCost: {},
		ask: { calls: 0, cancelled: 0, errors: 0, durSum: 0, durN: 0, buckets: ASK_BUCKETS.map(() => 0).concat(0), sources: {} },
		monitors: { started: 0, finished: 0, statuses: {}, durSum: 0, durN: 0 },
		subagents: {},
		subagentCost: {},
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 },
		models: {},
		detectors: {},
		detectorVersions: {},
		notices: {},
		compactions: 0,
	};
}

export const bump = (map: Record<string, number>, key: string, by = 1) => {
	map[key] = (map[key] ?? 0) + by;
};

export function bucketOf(ms: number): number {
	const i = ASK_BUCKETS.findIndex((limit) => ms < limit);
	return i < 0 ? ASK_BUCKETS.length : i;
}

function addCounts(into: Record<string, number>, from: Record<string, number>) {
	for (const [k, v] of Object.entries(from)) bump(into, k, v);
}

function addLabels(into: Record<string, { pass: number; fail: number; na: number }>, from: Record<string, { pass: number; fail: number; na: number }>) {
	for (const [k, v] of Object.entries(from)) {
		const t = (into[k] ??= { pass: 0, fail: 0, na: 0 });
		t.pass += v.pass;
		t.fail += v.fail;
		t.na += v.na;
	}
}

export function addLabel(into: Record<string, { pass: number; fail: number; na: number }>, key: string, label: Label) {
	const t = (into[key] ??= { pass: 0, fail: 0, na: 0 });
	t[label] += 1;
}

/** Adds `from` into `into` and returns `into`. */
export function mergeDay(into: DayAgg, from: DayAgg): DayAgg {
	into.sessions += from.sessions;
	into.subagentSessions += from.subagentSessions;
	into.prompts += from.prompts;
	for (const [name, t] of Object.entries(from.tools)) {
		const a = (into.tools[name] ??= { calls: 0, errors: 0, durSum: 0, durN: 0 });
		a.calls += t.calls;
		a.errors += t.errors;
		a.durSum += t.durSum;
		a.durN += t.durN;
	}
	addCounts(into.skills, from.skills);
	addCounts(into.skillTriggers, from.skillTriggers);
	addCounts(into.skillSessions, from.skillSessions);
	addCounts(into.skillCost, from.skillCost);
	mergeAsk(into.ask, from.ask);
	mergeMonitors(into.monitors, from.monitors);
	addCounts(into.subagents, from.subagents);
	addCounts(into.subagentCost, from.subagentCost);
	for (const key of Object.keys(into.usage) as (keyof DayAgg["usage"])[]) into.usage[key] += from.usage[key];
	addCounts(into.models, from.models);
	addLabels(into.detectors, from.detectors);
	addLabels(into.detectorVersions, from.detectorVersions);
	addCounts(into.notices, from.notices);
	into.compactions += from.compactions;
	return into;
}

export function mergeAsk(into: DayAgg["ask"], from: DayAgg["ask"]) {
	into.calls += from.calls;
	into.cancelled += from.cancelled;
	into.errors += from.errors;
	into.durSum += from.durSum;
	into.durN += from.durN;
	from.buckets.forEach((v, i) => (into.buckets[i] = (into.buckets[i] ?? 0) + v));
	addCounts(into.sources, from.sources);
}

export function mergeMonitors(into: DayAgg["monitors"], from: DayAgg["monitors"]) {
	into.started += from.started;
	into.finished += from.finished;
	into.durSum += from.durSum;
	into.durN += from.durN;
	addCounts(into.statuses, from.statuses);
}

/** One session's derived facts: per-day aggregates plus the session-level fields the index joins on. */
export interface SessionSummary {
	v: 1;
	sessionId: string;
	project: string;
	start: string;
	end: string;
	kind: "interactive" | "subagent";
	/** Logical id of a subagent session (the first uuid of its file name). */
	logicalId?: string;
	/** Parent session id, when the brief's artifact path or a dispatch ledger names it. */
	parentId?: string;
	/** Logical ids of the subagents this session launched, with the role and model it asked for. */
	spawned: { id: string; role: string; model: string }[];
	cost: number;
	tokens: number;
	toolCalls: number;
	/** Session-level detector results (`na` outside the anchorloop 3.x era). */
	evals: Partial<Record<DetectorName, { label: Label; value?: number; explanation: string }>>;
	notices: Partial<Record<NoticeKind, number>>;
	/** Hash of the skill catalog pi offered this session (names in the index's catalog table). */
	catalog?: string;
	days: Record<string, DayAgg>;
}

/**
 * One session in a few numbers, keyed to its start time: what the before/after comparison of a change and the
 * version split read, so a change at 16:00 splits a day's sessions at 16:00 rather than at midnight.
 */
export interface SessionRow {
	/** Used for the date/project-scoped labels join. Older indices lack these two fields. */
	id?: string;
	linked?: boolean;
	/** Start, ISO. */
	s: string;
	p: string;
	/** 1 for a subagent session. */
	k: 0 | 1;
	/** Model cost, USD. */
	c: number;
	/** Tool → [calls, errors]. */
	t: Record<string, [number, number]>;
	/** Ask-user calls and dismissals. */
	ac: number;
	ax: number;
	/** Skill loads and close-guard notices. */
	sl: number;
	nt: number;
	/** Detector → 1 pass, 0 fail (in scope and applicable only). */
	ev: Record<string, 0 | 1>;
}

export function rowOf(start: string, project: string, subagent: boolean, cost: number, days: Record<string, DayAgg>, evals: Record<string, { label: Label } | undefined> = {}): SessionRow {
	const row: SessionRow = { s: start, p: project, k: subagent ? 1 : 0, c: Math.round(cost * 1e4) / 1e4, t: {}, ac: 0, ax: 0, sl: 0, nt: 0, ev: {} };
	for (const day of Object.values(days)) {
		for (const [tool, t] of Object.entries(day.tools)) {
			const cell = (row.t[tool] ??= [0, 0]);
			cell[0] += t.calls;
			cell[1] += t.errors;
		}
		row.ac += day.ask.calls;
		row.ax += day.ask.cancelled;
		row.sl += Object.values(day.skills).reduce((s, v) => s + v, 0);
		row.nt += Object.values(day.notices).reduce((s, v) => s + v, 0);
	}
	for (const [name, result] of Object.entries(evals)) {
		if (result?.label === "pass") row.ev[name] = 1;
		else if (result?.label === "fail") row.ev[name] = 0;
	}
	return row;
}
