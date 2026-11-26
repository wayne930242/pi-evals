import type { DayAgg } from "./aggregate.ts";
import type { DaysIndex } from "./build.ts";
import { ownerFor, sumDays } from "./model.ts";

const DAY = 86_400_000;

/** Counts by event date; session counts by skill in the index use session start date. */
export function recentDays(index: DaysIndex, project?: string) {
	if (!index.lastExtract || !index.range.start) return [];
	const end = Date.parse(index.lastExtract.slice(0, 10));
	const dates = Array.from({ length: 14 }, (_, i) => new Date(end - (14 - i) * DAY).toISOString().slice(0, 10));
	const rows = new Map(sumDays(index, { project, since: dates[0], until: dates[13] }).perDay);
	return dates.filter(d => d >= index.range.start.slice(0, 10)).map(day => ({ day, agg: rows.get(day) }));
}

interface Count { errors: number; calls: number }
const zero = (): Count => ({ errors: 0, calls: 0 });
function add(into: Count, from: Count) { into.errors += from.errors; into.calls += from.calls; }
export function packageCounts(index: DaysIndex, day?: DayAgg) {
	const by = new Map<string, Count>();
	for (const [tool, count] of Object.entries(day?.tools ?? {})) {
		const owner = ownerFor(index, tool), total = by.get(owner) ?? zero();
		add(total, count);
		by.set(owner, total);
	}
	return by;
}

function week(index: DaysIndex, rows: ReturnType<typeof recentDays>) {
	const packages = new Map<string, Count>(), monitors = zero();
	for (const { agg } of rows) {
		for (const [owner, count] of packageCounts(index, agg)) {
			const total = packages.get(owner) ?? zero();
			add(total, count);
			packages.set(owner, total);
		}
		if (agg) add(monitors, { errors: agg.monitors.statuses.error ?? 0, calls: agg.monitors.finished });
	}
	return { packages, monitors };
}

function rise(before: Count | undefined, after: Count) {
	if (!before || Math.min(before.calls, after.calls) < 20) return;
	// Compare integer counts before rounding the displayed rates (threshold: five percentage points).
	const diff = after.errors * before.calls - before.errors * after.calls;
	if (20 * diff >= before.calls * after.calls) return { before, after, delta: diff / before.calls / after.calls };
}
export function weeklyRises(index: DaysIndex, since?: string, project?: string) {
	const rows = recentDays(index, project);
	if (rows.length !== 14 || (since && Date.parse(rows[0].day) < Date.parse(since) - 86400000)) return;
	const prev = week(index, rows.slice(0, 7)), curr = week(index, rows.slice(7));
	const packages = [...curr.packages].flatMap(([name, count]) => {
		const r = rise(prev.packages.get(name), count);
		return r ? [{ name, ...r }] : [];
	}).sort((a, b) => b.delta - a.delta || b.after.calls - a.after.calls || a.name.localeCompare(b.name));
	return { start: rows[0].day, end: rows[13].day, packages, monitors: rise(prev.monitors, curr.monitors) };
}
