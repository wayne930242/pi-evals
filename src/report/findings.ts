import type { Rate, ReportModel } from "../model.ts";
import { type Change, type Lang, num, pct, usd, type Words, words } from "./format.ts";

type Key = "anchor_before_first_edit" | "check_after_last_edit" | "package_error_rate" | "tool_error_rate" | "cost_per_session";
export interface Reading {
	key: Key;
	label: string;
	direction: string;
	unit: string;
	before?: Rate;
	after?: Rate;
}
export function readings(c: Change, m: ReportModel, lang: Lang): Reading[] {
	const L = words(lang), i = c.impact;
	const has = (k: Key) => i?.before[k]?.value != null && i.after[k]?.value != null;
	const process = c.package === "pi-anchorloop" && has("anchor_before_first_edit");
	const keys: Key[] = process
		? ["anchor_before_first_edit", "check_after_last_edit"]
		: [has("package_error_rate") ? "package_error_rate" : "tool_error_rate", "cost_per_session"];
	return keys.map((key) => {
		const meta = m.meta.detectors[key] ?? m.meta.metrics[key === "package_error_rate" ? "tool_error_rate" : key];
		return {
			key,
			label: key === "package_error_rate" ? L("Package tool error rate", "套件工具出錯比例") : meta.label[lang],
			direction: meta.goodDirection === "higher" ? L("higher is better", "越高越好") : L("lower is better", "越低越好"),
			unit: key.endsWith("error_rate") ? L("calls", "次呼叫") : L("sessions", "段"),
			before: i?.before[key],
			after: i?.after[key],
		};
	});
}
export const value = (r: Reading, side: "before" | "after") => r.key === "cost_per_session" ? usd(r[side]?.value ?? null) : pct(r[side]);
const comparable = (r: Reading) => r.before?.value != null && r.after?.value != null;
export function verdict(c: Change, rs: Reading[], L: Words): string {
	const i = c.impact;
	if (!i) return L("Too early to tell: no earlier records.", "還看不出來：調整前沒有紀錄。");
	const notes: string[] = [];
	if (i.smallSample) notes.push(L("too few sessions", "樣本太少"));
	else if (rs.some((r) => comparable(r) && Math.min(r.before!.n, r.after!.n) < 20)) {
		notes.push(L("a reading is based on fewer than 20 observations", "有指標的樣本不到 20"));
	}
	if (i.incomplete) notes.push(L(`less than ${i.window.days} days on one side`, `一側未滿 ${i.window.days} 天`));
	if (!rs.some(comparable)) notes.push(L("no comparable readings", "沒有可比較的數字"));
	const other = i.confounded ? L(`${num(i.confounded)} other changes in the same period`, `同期還有 ${num(i.confounded)} 筆別的調整`) : "";
	if (notes.length || other) {
		return [notes.length ? L(`Too early to tell: ${notes.join("; ")}`, `還看不出來（${notes.join("、")}）`) : "", other].filter(Boolean)
			.join(" · ");
	}
	return rs.some((r) => comparable(r) && value(r, "before") !== value(r, "after"))
		? L("An observable difference, not proof of cause.", "看得出變化，但不能證明原因。")
		: L("No visible difference at this precision.", "依顯示精度，前後數字持平。");
}

export const eligible = (c: Change) => c.kind === "pin" || c.kind === "model-routing" || (!!c.impact && !c.impact.smallSample);
export function select(m: ReportModel) {
	const all = [...m.changes].sort((a, b) => b.at.localeCompare(a.at));
	const candidates = all.filter(eligible);
	const recent = candidates.filter((c) => Date.parse(c.at) >= Date.parse(all[0]?.at ?? "") - 7 * 86400000);
	const lead = recent.find((c) =>
		c.package === "pi-anchorloop" && (c.impact?.before.anchor_before_first_edit.n ?? 0) >= 20 &&
		(c.impact?.after.anchor_before_first_edit.n ?? 0) >= 20
	) ??
		candidates.find((c) => c.impact && !c.impact.smallSample) ?? candidates[0];
	const rest = candidates.filter((c) => c !== lead && c.at <= lead.at && (!lead.sha || c.sha !== lead.sha));
	const second = rest.find((c) => c.impact?.smallSample && c.impact.before.sessions && c.impact.after.sessions) ??
		rest.find((c) => (c.kind === "pin" || c.kind === "model-routing") && c.impact && !c.impact.incomplete) ?? rest[0];
	const highlighted = all.filter((c) => c === lead || c === second);
	return { all, lead, highlighted, folded: all.filter((c) => !highlighted.includes(c)) };
}
export function finding(c: Change, rs: Reading[], L: Words) {
	const r = rs.find(comparable);
	if (!r) return L("There are not enough records to compare this change", "這次調整還沒有足夠紀錄可比較");
	const dir = value(r, "before") === value(r, "after")
		? L(" held steady", "持平")
		: r.after!.value! > r.before!.value!
		? L(" rose", "上升")
		: L(" fell", "下降");
	const label = r.key === "anchor_before_first_edit" ? L("The share naming a check before editing", "先說驗證方法的比例") : r.label;
	return `${label}${dir}${
		c.impact?.confounded || c.impact?.smallSample || c.impact?.incomplete || Math.min(r.before!.n, r.after!.n) < 20
			? L("; the reason is unclear", "，原因還不明")
			: ""
	}`;
}
