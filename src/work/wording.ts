import type { Comparison, Verdict } from "./model.ts";
import type { Words } from "../report/format.ts";

export function verdictText(c: Comparison, v: Verdict, L: Words, lines = false) {
	const n = (name?: string) => {
		const g = c.groups.find(x => x.value === name);
		return (lines ? g?.nLines : g?.n) ?? 0;
	};
	const what = lines ? L("per 100 changed lines", "每改 100 行") : L("per item", "每件");
	if (v.kind === "single") return `${what}: ` + (v.a ? L(`only ${v.a} (${n(v.a)} items)`, `只有 ${v.a}（${n(v.a)} 件）`) : L("no items with line counts", "沒有可計算行數的工作"));
	const counts = L(`${n(v.a)} vs ${n(v.b)} items`, `${n(v.a)} 件 vs ${n(v.b)} 件`);
	if (v.kind === "few") return L(`${what}: too few to tell (${v.a} vs ${v.b}: ${counts}; need 5 each)`, `件數太少，還看不出來${what}誰比較省（${v.a} vs ${v.b}：${counts}，每組至少 5 件）`);
	if (v.kind === "same") return L(`${what}, ${v.a} and ${v.b} cost about the same (under 20% apart; ${counts})`, `${what}，${v.a} 和 ${v.b} 花費差不到兩成（${counts}）`);
	const pct = Math.round((v.by ?? 0) * 100);
	return L(`${what}, ${v.a} costs ${pct}% less than ${v.b} (${counts})`, `${v.a} ${what}比 ${v.b} 便宜 ${pct}%（${counts}）`);
}

export function comparisonText(c: Comparison, L: Words) {
	const a = c.verdict, b = c.verdictLines;
	let text = verdictText(c, a, L) + L("; ", "；") + verdictText(c, b, L, true) + L(".", "。");
	if ([a, b].every(v => v.kind === "same" || v.kind === "cheaper")) {
		if (![a.a, a.b].includes(b.a) || ![a.a, a.b].includes(b.b)) text += L(" The two measures compare different groups.", "兩種量法比較的不是同一對組別。");
		else if (a.kind !== b.kind || (a.kind === "cheaper" && a.a !== b.a)) text += L(" Item sizes may differ, so we can't say which is cheaper overall.", "兩種量法不一致，可能是工作大小不同，不能說誰比較省。");
	}
	return text;
}
