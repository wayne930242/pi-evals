/**
 * The report's 「工作」 numbers for one date range: the items, what they cost and where they closed or stalled, the
 * open items and what they wait on, and a like-with-like comparison that says plainly when there are too few items.
 */
import type { Filter } from "../model.ts";
import { CLOSE_KINDS, type CloseKind, type ItemsFile, STALL_KINDS, type WorkItem } from "./join.ts";
import type { StallKind } from "./track.ts";

/** A group needs at least this many items before the report compares it. */
export const MIN_ITEMS = 5;
/** Medians closer than this share are reported as no clear difference. */
export const SAME_WITHIN = 0.2;
const LIST_MAX = 60;
const OPEN_MAX = 15;

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const day = (iso?: string) => iso?.slice(0, 10) ?? "";
const roundOrNull = (v: number | null, d = 2) => (v === null ? null : round(v, d));
const minutes = (ms: number) => round(ms / 60_000, 1);
const total = (it: WorkItem) => it.mainCost + it.childCost;

export function median(values: number[]): number | null {
	if (!values.length) return null;
	const v = [...values].sort((a, b) => a - b);
	const mid = v.length >> 1;
	return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export interface Group {
	value: string;
	n: number;
	/** Median cost per item, USD. */
	median: number | null;
	nLines: number;
	/** Median cost per 100 changed lines, over the items with a line count. */
	per100: number | null;
}

export interface Verdict {
	/** `few`: a compared group has fewer than MIN_ITEMS; `same`: medians within 20%; `cheaper`: `a` costs less than `b`. */
	kind: "few" | "same" | "cheaper" | "single";
	a?: string;
	b?: string;
	/** How much less `a` costs than `b`, as a share of `b`. */
	by?: number;
}

export interface Comparison {
	dimension: "role" | "model" | "anchorloop";
	kind: "delegated" | "self";
	groups: Group[];
	verdict: Verdict;
	/** The same, per 100 changed lines, over items with a line count. */
	verdictLines: Verdict;
}

function verdictOf(groups: Group[], pick: (g: Group) => number | null, count: (g: Group) => number): Verdict {
	const usable = groups.filter((g) => count(g) > 0).sort((x, y) => count(y) - count(x));
	if (usable.length < 2) return { kind: "single", a: usable[0]?.value };
	const [x, y] = usable;
	if (count(x) < MIN_ITEMS || count(y) < MIN_ITEMS) return { kind: "few", a: x.value, b: y.value };
	const mx = pick(x) ?? 0;
	const my = pick(y) ?? 0;
	const [lo, hi] = mx <= my ? [x, y] : [y, x];
	const by = Math.max(mx, my) ? (Math.max(mx, my) - Math.min(mx, my)) / Math.max(mx, my) : 0;
	return by < SAME_WITHIN ? { kind: "same", a: x.value, b: y.value, by: round(by, 3) } : { kind: "cheaper", a: lo.value, b: hi.value, by: round(by, 3) };
}

function compare(items: WorkItem[]): Comparison[] {
	const out: Comparison[] = [];
	for (const kind of ["delegated", "self"] as const) {
		const pool = items.filter((it) => it.kind === kind);
		if (!pool.length) continue;
		// Model first: a role split mixes kinds of work (planning and building), so it is the weakest like-with-like.
		const dims: Comparison["dimension"][] = kind === "delegated" ? ["model", "anchorloop", "role"] : ["model", "anchorloop"];
		for (const dimension of dims) {
			const by = new Map<string, WorkItem[]>();
			for (const it of pool) {
				const value = (dimension === "role" ? it.role : dimension === "model" ? it.model : it.anchorloop) ?? "unknown";
				by.set(value, [...(by.get(value) ?? []), it]);
			}
			const groups: Group[] = [...by]
				.map(([value, list]) => {
					const sized = list.filter((it) => it.lines);
					const per = median(sized.map((it) => (100 * total(it)) / (it.lines as number)));
					const med = median(list.map(total));
					return { value, n: list.length, median: med === null ? null : round(med), nLines: sized.length, per100: per === null ? null : round(per) };
				})
				.sort((a, b) => b.n - a.n)
				.slice(0, 4);
			out.push({ dimension, kind, groups, verdict: verdictOf(groups, (g) => g.median, (g) => g.n), verdictLines: verdictOf(groups, (g) => g.per100, (g) => g.nLines) });
		}
	}
	return out;
}

export function workModel(file: ItemsFile | undefined, filter: Filter) {
	if (!file) return null;
	const since = filter.since ?? "";
	const until = filter.until ?? "9999";
	const top = file.items.filter((it) => it.level === "top" && (!filter.project || it.project === filter.project));
	const ended = top.filter((it) => (it.status === "completed" || it.status === "deleted") && day(it.close) >= since && day(it.close) <= until);
	const open = top.filter((it) => (it.status === "in_progress" || it.status === "pending") && day(it.lastActivity) >= since && day(it.created) <= until);
	const done = ended.filter((it) => it.status === "completed");
	const all = [...ended, ...open];
	const closeKinds = Object.fromEntries(CLOSE_KINDS.map((k) => [k, 0])) as Record<CloseKind, number>;
	for (const it of all) closeKinds[it.closeKind] += 1;
	const stallMs = Object.fromEntries(STALL_KINDS.map((k) => [k, 0])) as Record<StallKind, number>;
	for (const it of done) for (const [k, v] of Object.entries(it.stallMs) as [StallKind, number][]) stallMs[k] += v;
	const activeMs = done.reduce((s, it) => s + it.activeMs, 0);
	const sessions = new Set(all.map((it) => it.session));
	const unattributed = file.sessions.filter((s) => sessions.has(s.id)).reduce((sum, s) => sum + s.unattributed, 0);
	// Items whose windows overlapped another item of the same session: their main cost was split.
	const shared = done.filter((it) => it.start && done.some((o) => o !== it && o.session === it.session && o.start && o.start < (it.close ?? "") && it.start! < (o.close ?? ""))).length;
	const costed = done.filter((it) => it.activeMs > 0);
	const list = [...done].sort((a, b) => (b.close ?? "").localeCompare(a.close ?? "")).slice(0, LIST_MAX);
	return {
		present: true as const,
		built: file.built,
		n: all.length,
		completed: done.length,
		deleted: ended.length - done.length,
		inProgress: open.filter((it) => it.status === "in_progress").length,
		pending: open.filter((it) => it.status === "pending").length,
		delegated: done.filter((it) => it.kind === "delegated").length,
		withLines: done.filter((it) => it.lines).length,
		shared,
		cost: {
			main: round(done.reduce((s, it) => s + it.mainCost, 0)),
			child: round(done.reduce((s, it) => s + it.childCost, 0)),
			unattributed: round(unattributed),
			median: roundOrNull(median(costed.map(total))),
			medianMinutes: roundOrNull(median(costed.map((it) => minutes(it.activeMs))), 1),
		},
		closeKinds,
		stallMs,
		activeMs,
		list: list.map((it) => ({
			key: it.key,
			title: it.title,
			owner: it.owner ?? null,
			project: it.project,
			kind: it.kind,
			start: it.start ?? null,
			close: it.close ?? null,
			minutes: minutes(it.activeMs),
			main: round(it.mainCost),
			child: round(it.childCost),
			children: it.children.length,
			closeKind: it.closeKind,
			thread: it.thread ?? null,
			lines: it.lines ?? null,
			stalls: Object.fromEntries((Object.entries(it.stallMs) as [StallKind, number][]).filter(([, v]) => v > 0).map(([k, v]) => [k, minutes(v)])),
		})),
		open: open
			.filter((it) => it.status === "in_progress" && it.open)
			.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
			.slice(0, OPEN_MAX)
			.map((it) => ({
				key: it.key,
				title: it.title,
				owner: it.owner ?? null,
				project: it.project,
				session: it.session.slice(0, 13),
				start: it.start ?? null,
				since: it.open!.since,
				kind: it.open!.kind,
				on: it.open!.on ?? null,
				/** Minutes from the start of the wait to when the items were built (the extract). */
				waitMinutes: minutes(Math.max(0, Date.parse(file.built) - Date.parse(it.open!.since))),
				childCost: round(it.childCost),
				mainCost: round(it.mainCost),
			})),
		compare: compare(done.filter((it) => it.activeMs > 0)),
		minItems: MIN_ITEMS,
	};
}

export type WorkModel = NonNullable<ReturnType<typeof workModel>>;
