import type { ReportModel } from "../model.ts";
import type { Preset } from "../ranges.ts";
import { type Change, esc, type Lang, num, words } from "./format.ts";

const KINDS = ["pin", "model-routing", "rule", "agent-role", "skill", "manual"] as const;

/** Dense time slots get a count; every change still has its own mark and title. */
export function changeStrip(m: ReportModel, all: Change[], picks: Change[], ids: Map<Change, string>, lang: Lang, range: Preset | "custom") {
	const L = words(lang), label = (k: Change["kind"]) => m.meta.changeKinds[k][lang];
	const period = typeof range === "number" ? L(`Last ${range} days`, `近 ${range} 天`) : range === "all" ? L("All time", "全部期間") : L("Selected dates", "選定期間");
	const since = m.window.since ?? "", until = m.window.until ?? "", start = Date.parse(since), span = Date.parse(until) + 86400000 - start;
	const x = (c: Change) => 16 + Math.min(1, Math.max(0, (Date.parse(c.at) - start) / span)) * 968;
	const bins = new Map<number, Change[]>(), counts = new Map<string, number>();
	for (const c of all) {
		const slot = Math.floor((x(c) - 16) / 30), cells = bins.get(slot) ?? [];
		cells.push(c); bins.set(slot, cells); counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
	}
	const short = { pin: "版本", "model-routing": "模型路由", rule: "規則", "agent-role": "角色", skill: "skill", manual: "手動" };
	const breakdown = KINDS.map(k => `${L(label(k), short[k])} ${num(counts.get(k) ?? 0)}`).join(L(", ", "、"));
	const total = L(`${period}: ${num(all.length)} changes: ${breakdown}; ${picks.length} worth a closer look.`, `${period}共 ${num(all.length)} 筆調整：${breakdown}；其中 ${picks.length} 筆值得回看。`);
	const legend = KINDS.map(k => `<span><i class="key kind-${k}"></i>${esc(label(k))}: ${num(counts.get(k) ?? 0)}</span>`).join("");
	const base = 64, marks: string[] = [], labeled = new Map<Change, { px: number; py: number; dot: string }>();
	for (const [slot, cells] of bins) {
		cells.reverse(); // Earliest mark at the left of a dense slot.
		const left = 16 + slot * 30, columns = Math.ceil(cells.length / 5);
		cells.forEach((c, i) => {
			const px = cells.length <= 5 ? x(c) : left + (Math.floor(i / 5) + .5) * 28 / columns;
			const py = base - 6 - i % 5 * 5;
			const dot = `<circle class="change-mark kind-${c.kind}" cx="${px.toFixed(1)}" cy="${py}" r="${Math.min(2.4, 13 / columns)}"><title>${esc(c.at)} · ${esc(label(c.kind))}</title></circle>`;
			if (picks.includes(c)) labeled.set(c, { px, py, dot }); else marks.push(dot);
		});
		if (cells.length > 5) marks.push(`<text class="slot-count" x="${left + 14}" y="28" text-anchor="middle">×${cells.length}</text>`);
	}
	const links = picks.map((c,i) => {
		const {px, py, dot} = labeled.get(c)!, end = px > 700, caption = c.package ? `${c.package} ${c.to ?? ""}` : `${label(c.kind)} · ${c.at.slice(5,16).replace("T", " ")}`;
		const y = 87 + i * 23;
		return `<a href="#${ids.get(c)}"><title>${esc(caption)}</title><path class="guide" d="M${px} ${py}V${y - 6}h${end ? -7 : 7}"/>${dot}<text x="${px + (end ? -10 : 10)}" y="${y}" text-anchor="${end ? "end" : "start"}">${esc(Array.from(caption).length > 48 ? Array.from(caption).slice(0, 47).join("") + "…" : caption)}</text></a>`;
	}).join("");
	return `<section class="change-strip"><h2>${total}</h2><div class="kind-key">${legend}</div><svg viewBox="0 0 1000 ${base + 14 + picks.length * 23}" aria-label="${esc(total)}"><path class="axis" d="M16 ${base}H984"/>${marks.join("")}${links}</svg><div class="ends"><span>${esc(since)}</span><span>${esc(until)} UTC</span></div></section>`;
}
