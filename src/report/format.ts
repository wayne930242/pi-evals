import type { Rate, ReportModel } from "../model.ts";

export type Lang = "en" | "zh";
export type Words = (en: string, zh: string) => string;
export type Change = ReportModel["changes"][number];
export const words = (lang: Lang): Words => (en, zh) => lang === "zh" ? zh : en;
export const esc = (s: unknown) =>
	String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const formatter = new Intl.NumberFormat("en-US");
export const num = (n: number) => formatter.format(n);
export const pct = (r?: Rate) => r?.value != null ? `${(100 * r.value).toFixed(1)}%` : "—";
export const usd = (v: number | null) => v == null ? "—" : `$${v.toFixed(2)}`;
export const duration = (v: number | null) =>
	v == null ? "—" : v < 1000 ? `${v} ms` : v < 60_000 ? `${(v / 1000).toFixed(1)} s` : `${(v / 60_000).toFixed(1)} min`;
export const stamp = (at: string) => `${at.slice(5, 10).replace("-", ".")}　${at.slice(11, 16)}`;
export const title = (c: Change) => c.package ? `${c.package} ${c.from ?? "∅"} → ${c.to ?? "∅"}` : c.subject;
/** Cells are text, never markup. */
export function table(headers: string[], rows: (string | number)[][], L: Words) {
	if (!rows.length) return `<p class="muted">${L("No records in this period.", "這段期間沒有紀錄。")}</p>`;
	const cell = (x: string | number) => esc(typeof x === "number" ? num(x) : x);
	return `<div class="scroll"><table><thead><tr>${headers.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${
		rows.map((r) => `<tr>${r.map((c) => `<td>${cell(c)}</td>`).join("")}</tr>`).join("")
	}</tbody></table></div>`;
}
