import type { DaysIndex } from "./build.ts";
import type { ReportModel } from "./model.ts";
import { overview, readings, value, verdict } from "./report/findings.ts";
import { words } from "./report/format.ts";
import { safeName } from "./schema.ts";
import { weeklyRises } from "./trends.ts";

/** Shorten only identifiers, never a verdict or its drill-down pointer. */
function name(s: string) {
	const chars = Array.from(safeName(s));
	if (Buffer.byteLength(chars.join("")) <= 72) return chars.join("");
	while (Buffer.byteLength(chars.join("")) > 69) chars.pop();
	return chars.join("") + "…";
}
export function findings(m: ReportModel, index: DaysIndex) {
	const { headline, trust, highlighted } = overview(m, "en"), L = words("en");
	const lines = [
		`${m.window.since ?? "?"}..${m.window.until ?? "?"} UTC${m.window.project ? ` · ${name(m.window.project)}` : ""} · ${m.freshness.stale ? "STALE: " : ""}last extract ${m.freshness.lastExtract ?? "never"} → coverage`,
		`${headline} → changes`, `${trust} → changes`,
	];
	const extras: { line: number; prefix: string; metric: string }[] = [];
	for (const c of highlighted) {
		const id = c.package ? `${name(c.package)} ${name(c.to ?? "unknown")}` : c.kind;
		const rs = readings(c, m, "en"), r = rs.find(row => row.before?.value != null && row.after?.value != null);
		const metric = r ? `${r.label} ${value(r, "before")} → ${value(r, "after")}; ` : "";
		const prefix = `${c.at} ${id}: `;
		extras.push({ line: lines.length, prefix, metric });
		lines.push(`${prefix}${verdict(c, rs, L)} → changes`);
	}
	const unseen = m.skills.neverLoaded.length;
	lines.push(`${unseen}/${m.skills.offered} offered skills never loaded in range → skills`);
	const cov = m.coverage;
	const gate = !cov ? "not measured" : !cov.old.files ? "no old files" : cov.notIndexed.files || cov.notIndexed.bytes
		? `blocked: ${cov.notIndexed.files}/${cov.old.files} old files not indexed` : `all ${cov.old.files} old files indexed`;
	lines.push(`Cleanup (all projects/dates): ${gate} → coverage`);
	const w = weeklyRises(index, m.window.since ?? undefined, m.window.project ?? undefined);
	const pair = (r: { before: { errors: number; calls: number }; after: { errors: number; calls: number } }) => `${r.before.errors}/${r.before.calls} → ${r.after.errors}/${r.after.calls}`;
	if (!w) lines.push("Need two weeks in range for error trends → packages / monitors");
	else {
		const p = w.packages[0];
		lines.push(`${w.start}..${w.end} UTC, earlier week vs later: ${p ? `${p.name === "unknown" ? "tools with no known package" : name(p.name)} errors ${pair(p)}` : "no package rise flagged"} → packages`);
		lines.push(`Same weeks: ${w.monitors ? `jobs ending in error ${pair(w.monitors)}` : "no job error rise flagged"} → monitors`);
	}
	for (const { line, prefix, metric } of extras) {
		if (Buffer.byteLength(lines.join("\n") + metric) <= 1499) lines[line] = prefix + metric + lines[line].slice(prefix.length);
	}
	return lines.join("\n");
}
