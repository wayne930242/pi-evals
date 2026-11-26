/**
 * The ReportModel: every number the report can show, each with its n and window, plus the plain-language
 * metadata to explain it. The renderer reads only this; `evals_query` reads parts of it.
 */
import { existsSync } from "node:fs";
import { ASK_BUCKETS, type DayAgg, emptyDay, mergeDay, type SessionRow } from "./aggregate.ts";
import type { DaysIndex } from "./build.ts";
import { atLeast, type Change, versionAt } from "./changes.ts";
import type { Coverage } from "./coverage.ts";
import { DETECTORS, ERA_START } from "./detectors.ts";
import { CHANGE_KIND_META, CLOSE_KIND_META, DETECTOR_META, METRICS, NOTICE_META, STALL_KIND_META } from "./meta.ts";
import { staticOwner } from "./owners.ts";
import { weeklyRises } from "./trends.ts";
import { asksModel } from "./asks.ts";
import { labelsModel } from "./labels.ts";
import { ANCHORLOOP, type ItemsFile } from "./work/join.ts";
import { workModel } from "./work/model.ts";

export const SMALL_SAMPLE = 20;
/** Data older than this (hours) is reported as stale. */
export const STALE_HOURS = 24;

export interface Filter {
	since?: string;
	until?: string;
	project?: string;
}

export interface Rate {
	value: number | null;
	n: number;
}

const rate = (num: number, den: number): Rate => ({ value: den > 0 ? num / den : null, n: den });
const round = (v: number, digits = 4) => Math.round(v * 10 ** digits) / 10 ** digits;

/** Aggregates over the days and project in the filter; also the per-day totals. */
export function sumDays(index: DaysIndex, filter: Filter): { total: DayAgg; perDay: [string, DayAgg][] } {
	const total = emptyDay();
	const perDay: [string, DayAgg][] = [];
	for (const day of Object.keys(index.days).sort()) {
		if (filter.since && day < filter.since) continue;
		if (filter.until && day > filter.until) continue;
		const dayTotal = emptyDay();
		for (const [project, agg] of Object.entries(index.days[day])) {
			if (filter.project && project !== filter.project) continue;
			mergeDay(dayTotal, agg);
		}
		mergeDay(total, dayTotal);
		perDay.push([day, dayTotal]);
	}
	return { total, perDay };
}

export function ownerFor(index: DaysIndex, tool: string): string {
	return index.owners[tool]?.owner ?? staticOwner(tool);
}

function packages(index: DaysIndex, total: DayAgg) {
	const by = new Map<string, { owner: string; version?: string; calls: number; errors: number; durSum: number; durN: number; tools: string[] }>();
	for (const [tool, t] of Object.entries(total.tools)) {
		const owner = ownerFor(index, tool);
		const row = by.get(owner) ?? { owner, version: Object.values(index.owners).find((o) => o.owner === owner)?.version, calls: 0, errors: 0, durSum: 0, durN: 0, tools: [] };
		row.calls += t.calls;
		row.errors += t.errors;
		row.durSum += t.durSum;
		row.durN += t.durN;
		row.tools.push(tool);
		by.set(owner, row);
	}
	return [...by.values()]
		.sort((a, b) => b.calls - a.calls)
		.map((r) => ({ owner: r.owner, version: r.version, calls: r.calls, errors: r.errors, errorRate: rate(r.errors, r.calls), avgMs: r.durN ? Math.round(r.durSum / r.durN) : null, tools: r.tools.sort() }));
}

function detectorRates(total: DayAgg) {
	return DETECTORS.map((name) => {
		const d = total.detectors[name] ?? { pass: 0, fail: 0, na: 0 };
		return { name, pass: d.pass, fail: d.fail, na: d.na, passRate: rate(d.pass, d.pass + d.fail) };
	});
}

const DAY = 86_400_000;

/** The handful of numbers compared before and after a change, over the sessions that started in one window. */
export function impactMetrics(rows: SessionRow[], ownerOf: (tool: string) => string, pkg?: string) {
	let calls = 0;
	let errors = 0;
	let pkgCalls = 0;
	let pkgErrors = 0;
	let ask = 0;
	let dismissed = 0;
	let cost = 0;
	let loads = 0;
	let notices = 0;
	const det: Record<string, [number, number]> = {};
	for (const r of rows) {
		for (const [tool, [c, e]] of Object.entries(r.t)) {
			calls += c;
			errors += e;
			if (pkg && ownerOf(tool) === pkg) {
				pkgCalls += c;
				pkgErrors += e;
			}
		}
		ask += r.ac;
		dismissed += r.ax;
		cost += r.c;
		loads += r.sl;
		notices += r.nt;
		for (const [name, v] of Object.entries(r.ev)) {
			const cell = (det[name] ??= [0, 0]);
			cell[0] += v;
			cell[1] += 1;
		}
	}
	const d = (name: string) => rate(det[name]?.[0] ?? 0, det[name]?.[1] ?? 0);
	return {
		sessions: rows.length,
		tool_error_rate: rate(errors, calls),
		package_error_rate: pkg ? rate(pkgErrors, pkgCalls) : undefined,
		ask_cancel_rate: rate(dismissed, ask),
		cost_per_session: rate(cost, rows.length),
		skill_loads_per_session: rate(loads, rows.length),
		notices_per_session: rate(notices, rows.length),
		anchor_before_first_edit: d("anchor_before_first_edit"),
		check_after_last_edit: d("check_after_last_edit"),
		todo_evidence: d("todo_evidence"),
		plan_names_graph: d("plan_names_graph"),
	};
}

/** Dotted versions in numeric order; anything else (unknown, a sha) after them. */
const byVersion = (a: string, b: string) => {
	const pa = /^\d+(\.\d+)*$/.test(a) ? a.split(".").map(Number) : undefined, pb = /^\d+(\.\d+)*$/.test(b) ? b.split(".").map(Number) : undefined;
	if (!pa || !pb) return pa ? -1 : pb ? 1 : a.localeCompare(b);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
	return 0;
};

/** A detector's results by the version of the package it measures, at each session's start, and before and from the version that brought it. */
export function packageSplit(rows: SessionRow[], changes: Change[], detector: string, since: { package: string; version: string }) {
	const versions = new Map<string, { pass: number; fail: number }>();
	const sides = { before: { pass: 0, fail: 0 }, after: { pass: 0, fail: 0 } };
	for (const r of rows) {
		const v = r.ev[detector];
		if (v === undefined) continue;
		const version = versionAt(changes, since.package, r.s) ?? "unknown";
		const cell = versions.get(version) ?? { pass: 0, fail: 0 };
		cell[v ? "pass" : "fail"] += 1;
		versions.set(version, cell);
		const later = atLeast(version, since.version);
		if (later !== undefined) sides[later ? "after" : "before"][v ? "pass" : "fail"] += 1;
	}
	const withRate = (x: { pass: number; fail: number }) => ({ ...x, passRate: rate(x.pass, x.pass + x.fail) });
	return {
		...since,
		versions: [...versions].sort(([a], [b]) => byVersion(a, b)).map(([version, x]) => ({ version, ...withRate(x) })),
		before: withRate(sides.before),
		after: withRate(sides.after),
	};
}

/** Changes from one commit (or one mark) count once. */
const commitOf = (c: Change) => c.sha ?? `${c.source}:${c.at}:${c.subject}`;

/**
 * Before = sessions that started in [at - W, at), after = [at, at + W), by start time. `incomplete` when either window
 * reaches past the data; `confounders` are the other commits inside both windows, by the kinds they changed.
 */
export function impactFromRows(rows: SessionRow[], change: Change, all: Change[], windowDays: number, range: { start: string; end: string }, ownerOf: (tool: string) => string) {
	const at = Date.parse(change.at);
	const lo = at - windowDays * DAY;
	const hi = at + windowDays * DAY;
	const before: SessionRow[] = [];
	const after: SessionRow[] = [];
	for (const r of rows) {
		const t = Date.parse(r.s);
		if (t >= lo && t < at) before.push(r);
		else if (t >= at && t < hi) after.push(r);
	}
	const daysWith = (list: SessionRow[]) => new Set(list.map((r) => r.s.slice(0, 10))).size;
	const self = commitOf(change);
	const others = new Map<string, Set<string>>();
	for (const c of all) {
		const t = Date.parse(c.at);
		if (t < lo || t >= hi || commitOf(c) === self) continue;
		const kinds = others.get(commitOf(c)) ?? new Set<string>();
		kinds.add(c.kind);
		others.set(commitOf(c), kinds);
	}
	const kinds: Record<string, number> = {};
	for (const set of others.values()) for (const k of set) kinds[k] = (kinds[k] ?? 0) + 1;
	const pkg = change.kind === "pin" ? change.package : undefined;
	return {
		window: { before: { since: new Date(lo).toISOString(), until: change.at }, after: { since: change.at, until: new Date(hi).toISOString() }, days: windowDays },
		before: impactMetrics(before, ownerOf, pkg),
		after: impactMetrics(after, ownerOf, pkg),
		daysWithData: { before: daysWith(before), after: daysWith(after) },
		incomplete: !range.start || lo < Date.parse(range.start) || hi > Date.parse(range.end || range.start),
		smallSample: before.length < SMALL_SAMPLE || after.length < SMALL_SAMPLE,
		confounded: others.size,
		confounders: kinds,
	};
}

export function buildModel(options: {
	index: DaysIndex;
	rows: SessionRow[];
	changes: Change[];
	/** Already computed for the same index, project and comparison settings. */
	comparisons?: (Change & { impact: ReturnType<typeof impactFromRows> | null })[];
	filter: Filter;
	windowDays: number;
	labelsFile: string;
	/** `asks.jsonl`, when the caller has one. */
	asksFile?: string;
	sessionEvalsFile: string;
	coverage?: Coverage;
	/** Joined work items (`index/items.json`), when built. */
	work?: ItemsFile;
	/** The user gave no end date: labels of sessions not indexed yet are not cut at `filter.until`. */
	openEnd?: boolean;
	now?: Date;
}) {
	const { index, filter } = options;
	const now = options.now ?? new Date();
	const { total, perDay } = sumDays(index, filter);
	const days = perDay.map(([d]) => d);
	const loaded = new Set(Object.keys(total.skills));
	const skillTop = Object.entries(total.skills)
		.sort((a, b) => b[1] - a[1])
		.map(([name, loads]) => ({ name, loads, sessions: total.skillSessions[name] ?? 0, cost: round(total.skillCost[name] ?? 0, 2), perDay: perDay.map(([, agg]) => agg.skills[name] ?? 0) }));
	const projectSkills = new Map<string, { project: string; skill: string; loads: number }>();
	for (const day of days) {
		for (const [project, agg] of Object.entries(index.days[day])) {
			if (filter.project && project !== filter.project) continue;
			for (const [skill, n] of Object.entries(agg.skills)) {
				const key = `${project}\u0000${skill}`;
				const row = projectSkills.get(key);
				if (row) row.loads += n;
				else projectSkills.set(key, { project, skill, loads: n });
			}
		}
	}
	const byProject = [...projectSkills.values()].sort((a, b) => b.loads - a.loads);
	const projectRows = filter.project ? options.rows.filter((r) => r.p === filter.project) : options.rows;
	const owner = (tool: string) => ownerFor(index, tool);
	const inRange = (at: string) => (!filter.since || at.slice(0, 10) >= filter.since) && (!filter.until || at.slice(0, 10) <= filter.until);
	const selected = projectRows.filter(r => inRange(r.s)), children = selected.filter(r => r.k);
	const scoped = Boolean(filter.since || filter.until || filter.project);
	const hasSessionIds = selected.every(r => r.id !== undefined);
	const labelIds = scoped && (existsSync(options.labelsFile) || (!!options.asksFile && existsSync(options.asksFile))) ? new Set(selected.flatMap(r => r.id ? [r.id] : [])) : undefined;
	const indexedIds = labelIds && new Set(options.rows.flatMap(r => r.id ? [r.id] : []));
	const labelScope = { ...filter, until: options.openEnd ? undefined : filter.until, selected: labelIds, indexed: indexedIds };
	const calls = Object.values(total.tools).reduce((s, t) => s + t.calls, 0);
	const errors = Object.values(total.tools).reduce((s, t) => s + t.errors, 0);
	const tokens = total.usage.input + total.usage.output + total.usage.cacheRead + total.usage.cacheWrite;
	const lastExtract = index.lastExtract;
	const ageHours = lastExtract ? (now.getTime() - Date.parse(lastExtract)) / 3_600_000 : Number.POSITIVE_INFINITY;
	const versions = new Map<string, { version: string; pass: number; fail: number }[]>();
	for (const [key, v] of Object.entries(total.detectorVersions)) {
		const [name, version] = key.split("|");
		const list = versions.get(name) ?? [];
		list.push({ version, pass: v.pass, fail: v.fail });
		versions.set(name, list);
	}
	const sortedChanges = [...options.changes].sort((a, b) => a.at.localeCompare(b.at));
	const earliest = [days[0], sortedChanges.find(c => inRange(c.at))?.at.slice(0, 10)].filter(Boolean).sort()[0];
	return {
		v: 1 as const,
		generated: now.toISOString(),
		weekly: weeklyRises(index, filter.since ?? earliest, filter.project),
		window: { since: filter.since ?? earliest ?? null, until: filter.until ?? days.at(-1) ?? null, days: days.length, project: filter.project ?? null },
		freshness: { lastExtract: lastExtract ?? null, built: index.built, stale: ageHours > STALE_HOURS, ageHours: Number.isFinite(ageHours) ? round(ageHours, 1) : null },
		meta: { metrics: METRICS, detectors: DETECTOR_META, notices: NOTICE_META, changeKinds: CHANGE_KIND_META, closeKinds: CLOSE_KIND_META, stallKinds: STALL_KIND_META },
		totals: {
			sessions: total.sessions,
			subagentSessions: total.subagentSessions,
			prompts: total.prompts,
			toolCalls: calls,
			toolErrorRate: rate(errors, calls),
			cost: round(total.usage.cost, 2),
			tokens,
			modelReplies: total.usage.calls,
			compactions: total.compactions,
			indexSessions: index.sessions,
		},
		series: {
			days,
			sessions: perDay.map(([, a]) => a.sessions),
			toolCalls: perDay.map(([, a]) => Object.values(a.tools).reduce((s, t) => s + t.calls, 0)),
			cost: perDay.map(([, a]) => round(a.usage.cost, 2)),
			skillLoads: perDay.map(([, a]) => Object.values(a.skills).reduce((s, v) => s + v, 0)),
		},
		skills: {
			top: skillTop,
			byProject: byProject.slice(0, 200),
			triggers: total.skillTriggers,
			offered: index.offeredSkills.length,
			neverLoaded: index.offeredSkills.filter((s) => !loaded.has(s)),
		},
		packages: packages(index, total),
		tools: Object.entries(total.tools)
			.sort((a, b) => b[1].calls - a[1].calls)
			.map(([name, t]) => ({ name, owner: ownerFor(index, name), calls: t.calls, errors: t.errors, errorRate: rate(t.errors, t.calls), avgMs: t.durN ? Math.round(t.durSum / t.durN) : null })),
		askUser: {
			calls: total.ask.calls,
			cancelled: total.ask.cancelled,
			errors: total.ask.errors,
			cancelRate: rate(total.ask.cancelled, total.ask.calls),
			avgWaitMs: total.ask.durN ? Math.round(total.ask.durSum / total.ask.durN) : null,
			waitN: total.ask.durN,
			buckets: total.ask.buckets.map((n, i) => ({ upToMs: ASK_BUCKETS[i] ?? null, n })),
			sources: total.ask.sources,
		},
		monitors: {
			started: total.monitors.started,
			finished: total.monitors.finished,
			statuses: total.monitors.statuses,
			avgMs: total.monitors.durN ? Math.round(total.monitors.durSum / total.monitors.durN) : null,
			durationN: total.monitors.durN,
		},
		subagents: {
			sessions: total.subagentSessions,
			launches: Object.entries(total.subagents)
				.map(([key, n]) => ({ role: key.split("|")[0], model: key.split("|")[1] ?? "unknown", n }))
				.sort((a, b) => b.n - a.n),
			costByRole: Object.entries(total.subagentCost)
				.map(([role, cost]) => ({ role, cost: round(cost, 2) }))
				.sort((a, b) => b.cost - a.cost),
			linked: scoped ? (children.every(r => r.linked !== undefined) ? children.filter(r => r.linked).length : null) : index.sessions.linked,
			subagentTotal: scoped ? children.length : index.sessions.subagent,
		},
		process: {
			eraStart: ERA_START,
			detectors: detectorRates(total).map((d) => ({
				...d,
				perDay: perDay.map(([day, a]) => {
					const x = a.detectors[d.name] ?? { pass: 0, fail: 0, na: 0 };
					return { day, pass: x.pass, fail: x.fail };
				}),
				byVersion: (versions.get(d.name) ?? []).map((v) => ({ ...v, passRate: rate(v.pass, v.pass + v.fail) })),
				byPackage: DETECTOR_META[d.name]?.introducedIn ? packageSplit(selected, sortedChanges, d.name, DETECTOR_META[d.name].introducedIn!) : null,
			})),
			notices: total.notices,
		},
		cost: {
			total: round(total.usage.cost, 2),
			perSession: rate(total.usage.cost, total.sessions),
			byModel: Object.entries(total.models)
				.sort((a, b) => b[1] - a[1])
				.map(([model, replies]) => ({ model, replies })),
			bySkill: skillTop
				.slice()
				.sort((a, b) => b.cost - a.cost)
				.slice(0, 25)
				.map(({ name, cost, sessions }) => ({ skill: name, cost, sessions })),
		},
		changes: options.comparisons?.filter(c => inRange(c.at)) ?? sortedChanges
			.filter((c) => inRange(c.at))
			.map((c) => ({ ...c, impact: index.range.start && c.at > index.range.start ? impactFromRows(projectRows, c, sortedChanges, options.windowDays, index.range, owner) : null })),
		labels: {
			...labelsModel(options.labelsFile, options.sessionEvalsFile, labelScope, (at) => versionAt(sortedChanges, ANCHORLOOP, at)),
			asks: asksModel(options.asksFile, options.labelsFile, labelScope),
			needsIndex: !!labelIds && !hasSessionIds,
		},
		coverage: options.coverage ?? null,
		work: workModel(options.work, filter),
	};
}

export type ReportModel = ReturnType<typeof buildModel>;
