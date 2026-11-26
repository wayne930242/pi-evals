/**
 * The ReportModel: every number the report can show, each with its n and window, plus the plain-language
 * metadata to explain it. The renderer reads only this; `evals_query` reads parts of it.
 */
import { existsSync, readFileSync } from "node:fs";
import { ASK_BUCKETS, type DayAgg, emptyDay, mergeDay } from "./aggregate.ts";
import type { DaysIndex } from "./build.ts";
import type { Change } from "./changes.ts";
import type { Coverage } from "./coverage.ts";
import { DETECTORS } from "./detectors.ts";
import { CHANGE_KIND_META, DETECTOR_META, METRICS, NOTICE_META } from "./meta.ts";
import { staticOwner } from "./owners.ts";
import { dayOf } from "./paths.ts";

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

/** The handful of numbers compared before and after a change. */
export function impactMetrics(agg: DayAgg) {
	const calls = Object.values(agg.tools).reduce((s, t) => s + t.calls, 0);
	const errors = Object.values(agg.tools).reduce((s, t) => s + t.errors, 0);
	const loads = Object.values(agg.skills).reduce((s, v) => s + v, 0);
	const notices = Object.values(agg.notices).reduce((s, v) => s + v, 0);
	const det = (name: string) => {
		const d = agg.detectors[name] ?? { pass: 0, fail: 0, na: 0 };
		return rate(d.pass, d.pass + d.fail);
	};
	return {
		sessions: agg.sessions,
		tool_error_rate: rate(errors, calls),
		ask_cancel_rate: rate(agg.ask.cancelled, agg.ask.calls),
		cost_per_session: rate(agg.usage.cost, agg.sessions),
		skill_loads_per_session: rate(loads, agg.sessions),
		notices_per_session: rate(notices, agg.sessions),
		anchor_before_first_edit: det("anchor_before_first_edit"),
		check_after_last_edit: det("check_after_last_edit"),
		todo_evidence: det("todo_evidence"),
	};
}

/** Sum of per-day totals over [since, until]. */
function windowSum(dayTotals: Map<string, DayAgg>, since: string, until: string): DayAgg {
	const out = emptyDay();
	for (let ms = Date.parse(since); ms <= Date.parse(until); ms += 86_400_000) {
		const agg = dayTotals.get(dayOf(ms));
		if (agg) mergeDay(out, agg);
	}
	return out;
}

function impact(index: DaysIndex, dayTotals: Map<string, DayAgg>, change: Change, all: Change[], windowDays: number, project?: string) {
	const day = change.at.slice(0, 10);
	const ms = Date.parse(day);
	const before = { since: dayOf(ms - windowDays * 86_400_000), until: dayOf(ms - 86_400_000), project };
	const after = { since: day, until: dayOf(ms + (windowDays - 1) * 86_400_000), project };
	const b = windowSum(dayTotals, before.since, before.until);
	const a = windowSum(dayTotals, after.since, after.until);
	const lo = Date.parse(before.since);
	const hi = Date.parse(after.until) + 86_399_999;
	const others = all.filter((c) => c !== change && (!change.sha || c.sha !== change.sha) && Date.parse(c.at) >= lo && Date.parse(c.at) <= hi).length;
	const pkgRate = (agg: DayAgg) => {
		if (change.kind !== "pin" || !change.package) return undefined;
		let calls = 0;
		let errors = 0;
		for (const [tool, t] of Object.entries(agg.tools)) {
			if (ownerFor(index, tool) !== change.package) continue;
			calls += t.calls;
			errors += t.errors;
		}
		return rate(errors, calls);
	};
	return {
		window: { before, after, days: windowDays },
		before: { ...impactMetrics(b), package_error_rate: pkgRate(b) },
		after: { ...impactMetrics(a), package_error_rate: pkgRate(a) },
		smallSample: b.sessions < SMALL_SAMPLE || a.sessions < SMALL_SAMPLE,
		confounded: others,
	};
}

interface LabelRow {
	session_id: string;
	evaluation_name: string;
	label: string;
}

function labelsJoin(labelsFile: string, evalsFile: string) {
	if (!existsSync(labelsFile)) return { present: false, n: 0, agreement: [] as { detector: string; n: number; agree: number; rate: Rate }[] };
	const codeLabels = existsSync(evalsFile) ? (JSON.parse(readFileSync(evalsFile, "utf8")) as Record<string, Record<string, string>>) : {};
	const rows: LabelRow[] = readFileSync(labelsFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as LabelRow];
			} catch {
				return [];
			}
		});
	const by = new Map<string, { n: number; agree: number }>();
	for (const row of rows) {
		const code = codeLabels[row.session_id]?.[row.evaluation_name];
		if (!code || code === "na") continue;
		const t = by.get(row.evaluation_name) ?? { n: 0, agree: 0 };
		t.n += 1;
		if (code === row.label) t.agree += 1;
		by.set(row.evaluation_name, t);
	}
	return { present: true, n: rows.length, agreement: [...by].map(([detector, t]) => ({ detector, n: t.n, agree: t.agree, rate: rate(t.agree, t.n) })) };
}

export function buildModel(options: {
	index: DaysIndex;
	changes: Change[];
	filter: Filter;
	windowDays: number;
	labelsFile: string;
	sessionEvalsFile: string;
	coverage?: Coverage;
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
	const dayTotals = new Map(sumDays(index, { project: filter.project }).perDay);
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
	const firstDay = Object.keys(index.days).sort()[0] ?? "";
	return {
		v: 1 as const,
		generated: now.toISOString(),
		window: { since: days[0] ?? filter.since ?? null, until: days.at(-1) ?? filter.until ?? null, days: days.length, project: filter.project ?? null },
		freshness: { lastExtract: lastExtract ?? null, built: index.built, stale: ageHours > STALE_HOURS, ageHours: Number.isFinite(ageHours) ? round(ageHours, 1) : null },
		meta: { metrics: METRICS, detectors: DETECTOR_META, notices: NOTICE_META, changeKinds: CHANGE_KIND_META },
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
			linked: index.sessions.linked,
			subagentTotal: index.sessions.subagent,
		},
		process: {
			eraStart: "2026-11-23",
			detectors: detectorRates(total).map((d) => ({
				...d,
				perDay: perDay.map(([day, a]) => {
					const x = a.detectors[d.name] ?? { pass: 0, fail: 0, na: 0 };
					return { day, pass: x.pass, fail: x.fail };
				}),
				byVersion: (versions.get(d.name) ?? []).map((v) => ({ ...v, passRate: rate(v.pass, v.pass + v.fail) })),
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
		changes: sortedChanges
			.filter((c) => (!filter.since || c.at.slice(0, 10) >= filter.since) && (!filter.until || c.at.slice(0, 10) <= filter.until))
			.map((c) => ({ ...c, impact: firstDay && c.at.slice(0, 10) > firstDay ? impact(index, dayTotals, c, sortedChanges, options.windowDays, filter.project) : null })),
		labels: labelsJoin(options.labelsFile, options.sessionEvalsFile),
		coverage: options.coverage ?? null,
	};
}

export type ReportModel = ReturnType<typeof buildModel>;
