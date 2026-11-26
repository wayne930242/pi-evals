import type { Filter } from "./model.ts";

export const PRESETS = [14, 30, 90, "all"] as const;
export type Preset = typeof PRESETS[number];
export const suffix = (r: Preset | "custom") => r === 30 ? "" : typeof r === "number" ? `-${r}d` : `-${r}`;

/** Calendar ranges include the (possibly partial) UTC day of the last extraction. */
export function rangeFilter(input: Filter & { days?: number }, end: string, preset: Preset = 30): Filter {
	const until = input.until ?? end.slice(0, 10), days = input.days ?? preset;
	if (input.since && input.days !== undefined) throw new Error("Choose either --days or --since.");
	if (days !== "all" && (!Number.isSafeInteger(days) || days < 1 || days > 365000)) throw new Error("--days must be a positive integer (at most 365000).");
	if (input.since && (!/^\d{4}-\d\d-\d\d$/.test(input.since) || !Number.isFinite(Date.parse(input.since)) || new Date(input.since).toISOString().slice(0, 10) !== input.since)) throw new Error("since must be YYYY-MM-DD.");
	const since = input.since ?? (days === "all" ? undefined : new Date(Date.parse(until) - (days - 1) * 86400000).toISOString().slice(0, 10));
	return { since, until, project: input.project };
}
