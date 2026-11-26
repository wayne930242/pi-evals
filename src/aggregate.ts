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
