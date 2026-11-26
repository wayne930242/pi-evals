import type { ReportModel } from "../model.ts";
import { esc, num, type Words } from "./format.ts";

/** Last seven calendar days ending on the last complete UTC day in the selected period. */
export function week(m: ReportModel) {
	const last = m.freshness.lastExtract?.slice(0, 10);
	if (!last || !m.window.until || !m.window.since) return [];
	const end = Math.min(Date.parse(last) - 86400000, Date.parse(m.window.until));
	const rows = [];
	for (let t = Math.max(end - 6 * 86400000, Date.parse(m.window.since)); t <= end; t += 86400000) {
		const day = new Date(t).toISOString().slice(0, 10), i = m.series.days.indexOf(day);
		rows.push({
			day,
			sessions: m.series.sessions[i] ?? 0,
			calls: m.series.toolCalls[i] ?? 0,
			loads: m.series.skillLoads[i] ?? 0,
			changes: m.changes.filter((c) => c.at.startsWith(day)).length,
		});
	}
	return rows;
}
export type Week = ReturnType<typeof week>;
export function workload(rows: Week, L: Words) {
	const heading = `<h2>${L("This week’s workload", "這週的工作量")}</h2>`;
	if (!rows.length) return `<div class="panel">${heading}<p>${L("No complete recorded day yet.", "尚無完整一天的紀錄。")}</p></div>`;
	const total = (key: "sessions" | "calls" | "loads") => num(rows.reduce((n, r) => n + r[key], 0));
	const max = Math.max(1, ...rows.map((r) => r.sessions));
	const points = rows.map((r, i) => [5 + i * 348 / Math.max(1, rows.length - 1), 89 - 64 * r.sessions / max]);
	const line = points.map((p) => p.join(",")).join(" ");
	const md = (d: string) => d.slice(5).replace("-", ".");
	const desc = rows.map((r) => `${r.day}: ${num(r.sessions)} ${L("sessions", "段工作")} · ${r.changes} ${L("changes", "筆調整")}`).join(
		"; ",
	);
	return `<div class="panel workload">${heading}<p class="muted">${md(rows[0].day)}–${md(rows.at(-1)!.day)}　／　${
		L("Volume is not quality", "多寡不代表好壞")
	}</p><h3>${total("sessions")} ${L("sessions", "段工作")}</h3><p class="muted">${
		L("Sessions per day · dashes mark changes", "每日工作段數 · 虛線表示當天有調整")
	}</p>
<svg role="img" aria-label="${esc(desc)}" viewBox="0 0 358 96"><polygon points="5,89 ${line} ${
		points.at(-1)![0]
	},89" class="area"/><polyline points="${line}" class="trend"/>${
		points.map(([x, y], i) =>
			rows[i].changes
				? `<path d="M${x} 12V89" class="marker"/><circle cx="${x}" cy="${y}" r="3.5" class="dot"><title>${esc(rows[i].day)}: ${
					rows[i].changes
				} ${L("changes", "筆調整")}</title></circle>`
				: ""
		).join("")
	}</svg>
<div class="ends"><span>${md(rows[0].day)}　${num(rows[0].sessions)}</span><span>${md(rows.at(-1)!.day)}　${
		num(rows.at(-1)!.sessions)
	}</span></div><p class="footline">${L("Tool calls", "工具呼叫")} ${total("calls")}　／　${L("Skill loads", "讀取技能")} ${
		total("loads")
	}</p></div>`;
}
