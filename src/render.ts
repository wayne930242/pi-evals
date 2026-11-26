/** Offline, script-free views of one ReportModel. A fragment selects a detail page without loading another file. */
import type { ReportModel } from "./model.ts";
import { concepts, lesson } from "./report/concepts.ts";
import { esc, type Lang, num, words } from "./report/format.ts";
import { sections } from "./report/sections.ts";
import { css } from "./report/style.ts";
import { timeline } from "./report/timeline.ts";
import { PRESETS, type Preset, suffix } from "./ranges.ts";
import { periodRows, workload } from "./report/week.ts";
export type { Lang } from "./report/format.ts";

export function renderHtml(m: ReportModel, lang: Lang = "zh", range: Preset | "custom" = "custom"): string {
	const L = words(lang), w = periodRows(m), t = timeline(m, w, lang, range), c = concepts(m, w, t.lead, L);
	const nav = [
		["archive", L("All changes", "所有調整")],
		["skills", L("Skills", "技能")],
		["packages", L("Tools", "套件與工具")],
		["ask", L("Questions", "提問")],
		["monitors", L("Jobs", "背景工作")],
		["subagents", L("Subagents", "子代理")],
		["process", L("Process checks", "流程檢查")],
		["cost", L("Cost", "費用")],
		["coverage", L("Cleanup", "清理門檻")],
		["labels", L("Labels", "你的標記")],
		["concepts", L("Concepts", "概念")],
	];
	const date = m.generated.slice(0, 10);
	return `<!doctype html><html lang="${
		lang === "zh" ? "zh-Hant-TW" : "en"
	}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>pi-evals · ${
		L("Change timeline", "調整時間軸")
	}</title><style>${css}</style></head><body><header><a href="#timeline" class="brand"><svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true"><rect width="30" height="30" rx="8" fill="#174e47"/><path d="M7 22V15M15 22V8M23 22V12" fill="none" stroke="white" stroke-width="3"/></svg>pi-evals<span>${
		L("Agent work, observed", "代理工作觀察")
	}</span></a><small>${esc(date)} ${L("report", "更新")}　／　${L("All times UTC", "時間皆為 UTC")}</small></header>
<main id="timeline"><div class="ranges">${range === "custom" ? "" : `<nav aria-label="${L("Time range", "時間範圍")}">${PRESETS.map(p => `<a href="report${suffix(p)}.html"${p === range ? ' aria-current="page"' : ""}>${p === "all" ? L("All time", "全部") : L(`Last ${p} days`, `近 ${p} 天`)}</a>`).join("")}</nav>`}<small>${esc(m.window.since ?? "—")} – ${esc(m.window.until ?? "—")} UTC</small></div>${t.strip}<div class="hero"><p class="eyebrow">${L("Change journal　／　Newest first", "調整紀事　／　依更新時間排列")}</p><h1>${
		esc(t.headline)
	}</h1><p class="deck">${esc(t.trust)}</p>${
		m.freshness.stale
			? `<p class="stale">${L("Last extract", "上次抽取")}：${esc(m.freshness.lastExtract ?? "—")} · ${
				L("Refresh with /evals extract.", "資料過時，請執行 /evals extract。")
			}</p>`
			: ""
	}</div>
<div class="spine"><h2>${
		L(`${t.count} changes worth a closer look`, `${t.count === 2 ? "兩" : t.count === 1 ? "一" : "零"}筆值得回看的調整`)
	}</h2><div class="layout"><div class="rail">${
		t.cards || `<p>${L("Nothing to highlight yet.", "還沒有適合比較的調整。")}</p>`
	}</div><aside class="side">${workload(w, L)}${lesson(c.record, L)}${lesson(c.metric, L)}</aside></div><details><summary>${
		L("How to read the comparisons", "怎麼讀時間軸上的比較？")
	}</summary><div class="notes-grid">${lesson(c.sample, L)}${lesson(c.confounding, L)}${lesson(c.check, L)}</div></details></div>
<nav class="jump" aria-label="${L("Report sections", "報表章節")}">${
		nav.map(([id, text]) => `<a href="#${id}">${text}</a>`).join("")
	}</nav><section class="topic" id="archive"><h2>${L("Other changes by day", "按日期查其餘調整")}</h2><p>${
		L("Open a day for its changes. Each link opens the before-and-after comparison.", "展開一天，點選調整名稱，就能看到它的前後比較。")
	}</p>${t.archive || "—"}</section>
<p class="muted">${esc(m.window.project ?? L("All projects", "全部專案"))} · ${esc(m.window.since ?? "—")} → ${
		esc(m.window.until ?? "—")
	} · ${num(m.totals.sessions)} ${L("sessions", "段工作")} · ${num(m.totals.prompts)} ${L("prompts", "次提示")}</p>${
		sections(m, lang, c)
	}</main>
${t.details}<footer><b>PI-EVALS　／　${L("Change timeline", "調整時間軸")}</b><span>${
		esc(m.window.project ?? L("All projects", "全部專案"))
	} · ${L("Transcript text not included", "統計不含對話原文")}</span></footer></body></html>`;
}
