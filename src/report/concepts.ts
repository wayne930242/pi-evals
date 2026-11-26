import type { ReportModel } from "../model.ts";
import { type Change, esc, num, type Words } from "./format.ts";
import type { Week } from "./week.ts";

export function concepts(m: ReportModel, week: Week, c: Change | undefined, L: Words) {
	const i = c?.impact,
		n = num(week.reduce((s, r) => s + r.sessions, 0)),
		d = m.process.detectors.find((r) => r.name === "anchor_before_first_edit");
	return {
		record: [
			L("Record", "紀錄"),
			L(
				`A tool call leaves a record: ${
					num(week.reduce((s, r) => s + r.calls, 0))
				} calls in this chart’s period. The words exchanged are not kept.`,
				`一次工具呼叫留下一筆紀錄。圖中這幾天共 ${num(week.reduce((s, r) => s + r.calls, 0))} 次，不保留對話原文。`,
			),
		],
		metric: [
			L("Metric", "指標"),
			L(
				`Count sessions by their start date: ${n} in the chart. This measures workload, not whether the work was good.`,
				`把工作按開始日期計數，圖中共有 ${n} 段。這個指標量的是工作量，不是工作品質。`,
			),
		],
		sample: [
			L("Before, after and sample size", "前後比較與樣本數"),
			i
				? L(
					`Split sessions at the change time: ${num(i.before.sessions)} before and ${
						num(i.after.sessions)
					} after. Only sessions to which a rule applies count in its percentage.`,
					`依開始時間分組：調整前 ${num(i.before.sessions)} 段、調整後 ${
						num(i.after.sessions)
					} 段。算一條規則的通過比例時，只數適用的工作段。`,
				)
				: L(
					`There are ${num(m.totals.sessions)} sessions in the report. Without records on both sides, we cannot compare a change.`,
					`報表裡有 ${num(m.totals.sessions)} 段工作。調整前後都要有紀錄，才有兩組數字能比。`,
				),
		],
		confounding: [
			L("Other changes at the same time", "同期多個調整"),
			i
				? L(
					`There were ${
						num(i.confounded)
					} other changes in these windows. If a rule and a package changed together, their effects cannot be separated here.`,
					`這段期間另有 ${num(i.confounded)} 筆調整。規則和套件若一起改，只比前後分不出哪一項影響了結果。`,
				)
				: L(
					`There are ${num(m.changes.length)} changes on this timeline. Check what else changed before crediting a new version.`,
					`時間軸有 ${num(m.changes.length)} 筆調整。要把差異歸給某個版本，得先查同一期間還改了什麼。`,
				),
		],
		check: [
			L("Code check", "程式檢查"),
			L(
				`In ${
					num(d?.passRate.n ?? 0)
				} eligible sessions, code checked whether the agent named a check before editing. It cannot judge whether that check tested the right thing.`,
				`程式在 ${num(d?.passRate.n ?? 0)} 段適用的工作裡查「改檔前有沒有先說怎麼驗證」。它看得出先後順序，判斷不了方法好不好。`,
			),
		],
	};
}
export function lesson(entry: string[], L: Words) {
	return `<aside class="lesson"><strong class="eyebrow">${L("Reading the numbers", "讀數字")}　／　${esc(entry[0])}</strong><p>${
		esc(entry[1])
	}</p></aside>`;
}
export function selfCheck(L: Words) {
	const item = (q: string, a: string) => `<p>${q}</p><details><summary>${L("Answer", "看答案")}</summary><p>${a}</p></details>`;
	return `<h3>${L("Check your reading", "試著判讀")}</h3>${
		item(
			L("1. Tool errors fell after a pin. Did the new version fix them?", "1. 更新後工具出錯比例下降，就能說是新版本修好了嗎？"),
			L(
				"Not from this alone. Check the window, the sample and what else changed.",
				"還不能。先看前後各有幾段工作、資料收齊了沒，以及同期還改了什麼。",
			),
		)
	}${
		item(
			L(
				"2. A session passed the check for naming a test before editing. Did the test cover the bug?",
				"2. 一段工作通過「動手前先說好怎麼驗證」，表示測試驗到了那個錯誤嗎？",
			),
			L(
				"The order was right. Whether the test could catch the bug is a different question.",
				"只知道順序對。那個測試抓不抓得到錯誤，要另外看測試內容。",
			),
		)
	}`;
}
