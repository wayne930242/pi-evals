import type { ReportModel } from "../model.ts";
import { esc, num, type Words } from "./format.ts";

/** Workload over the selected dates with records; the extraction day is partial. */
export function periodRows(m: ReportModel) {
	if (!m.series.days.length || !m.window.until || !m.window.since) return [];
	const end = Math.min(Date.parse(m.freshness.lastExtract?.slice(0, 10) ?? m.window.until), Date.parse(m.window.until));
	const positions = new Map(m.series.days.map((d, i) => [d, i]));
	const changes = new Map<string, Set<string>>(), totals = new Map<string, number>();
	for (const c of m.changes) {
		const day = c.at.slice(0, 10), kinds = changes.get(day) ?? new Set<string>();
		kinds.add(c.kind); changes.set(day, kinds); totals.set(day, (totals.get(day) ?? 0) + 1);
	}
	const rows = [];
	for (let t = Math.max(Date.parse(m.series.days[0]), Date.parse(m.window.since)); t <= end; t += 86400000) {
		const day = new Date(t).toISOString().slice(0, 10), i = positions.get(day) ?? -1;
		rows.push({
			day,
			sessions: m.series.sessions[i] ?? 0,
			calls: m.series.toolCalls[i] ?? 0,
			loads: m.series.skillLoads[i] ?? 0,
			changes: totals.get(day) ?? 0,
			kinds: [...(changes.get(day) ?? [])],
		});
	}
	return rows;
}
export type Week = ReturnType<typeof periodRows>;
export function workload(rows: Week, L: Words) {
	const heading = `<h2>${L("Workload in this period", "這段期間的工作量")}</h2>`;
	if (!rows.length) return `<div class="panel">${heading}<p>${L("No records in this period.", "這段期間沒有紀錄。")}</p></div>`;
	const total = (key: "sessions" | "calls" | "loads") => num(rows.reduce((n, r) => n + r[key], 0));
	const max = Math.max(1, ...rows.map((r) => r.sessions));
	const points = rows.map((r, i) => [5 + i * 348 / Math.max(1, rows.length - 1), 89 - 64 * r.sessions / max]);
	const line = points.map((p) => p.join(",")).join(" ");
	const md = (d: string) => d.slice(5).replace("-", ".");
	const desc = rows.map((r) => `${r.day}: ${num(r.sessions)} ${L("sessions", "段工作")} · ${r.changes} ${L("changes", "筆調整")}`).join(
		"; ",
	);
	return `<div class="panel workload">${heading}<p class="muted">${md(rows[0].day)}–${md(rows.at(-1)!.day)}　／　${
		L("Through the last extract", "統計至上次抽取")
	}</p><h3>${total("sessions")} ${L("sessions", "段工作")}</h3><p class="muted">${
		L("Sessions per day · colored dots mark changes", "每日工作段數 · 彩點表示當日調整類別")
	}</p>
<svg role="img" aria-label="${esc(desc)}" viewBox="0 0 358 96"><polygon points="5,89 ${line} ${
		points.at(-1)![0]
	},89" class="area"/><polyline points="${line}" class="trend"/>${
		points.map(([x], i) =>
			rows[i].changes
				? `<g><title>${esc(rows[i].day)}: ${num(rows[i].changes)} ${L("changes", "筆調整")}</title>${rows[i].kinds.map((k,j) => `<circle class="work-mark kind-${esc(k)}" cx="${x}" cy="${5 + 4*j}" r="1.9"/>`).join("")}</g>`
				: ""
		).join("")
	}</svg>
<div class="ends"><span>${md(rows[0].day)}　${num(rows[0].sessions)}</span><span>${md(rows.at(-1)!.day)}　${
		num(rows.at(-1)!.sessions)
	}</span></div><p class="footline">${L("Tool calls", "工具呼叫")} ${total("calls")}　／　${L("Skill loads", "讀取技能")} ${
		total("loads")
	}</p></div>`;
}
