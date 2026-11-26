/**
 * A plain, functional HTML renderer for the ReportModel: one file, no network, no external assets, inline SVG.
 * It reads only the model. The human-readable design comes later from approved mockups and replaces this file.
 */
import type { Text } from "./meta.ts";
import type { Rate, ReportModel } from "./model.ts";

export type Lang = "en" | "zh";

const esc = (v: unknown) =>
	String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const pct = (r: Rate | null | undefined) => (r && r.value !== null ? `${(r.value * 100).toFixed(1)}%` : "—");
const nOf = (r: Rate | null | undefined) => (r ? r.n : 0);
const ms = (v: number | null | undefined) => {
	if (v === null || v === undefined) return "—";
	if (v < 1000) return `${v} ms`;
	if (v < 60_000) return `${(v / 1000).toFixed(1)} s`;
	if (v < 3_600_000) return `${(v / 60_000).toFixed(1)} min`;
	return `${(v / 3_600_000).toFixed(1)} h`;
};
const usd = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `$${v.toFixed(2)}`);
const num = (v: number) => v.toLocaleString("en-US");

function bars(rows: { label: string; value: number; note?: string }[], width = 560): string {
	if (!rows.length) return `<p class="empty">—</p>`;
	const max = Math.max(...rows.map((r) => r.value), 1);
	const h = 18;
	const labelW = 220;
	const body = rows
		.map((r, i) => {
			const w = Math.max(1, Math.round(((width - labelW - 90) * r.value) / max));
			const y = i * (h + 4);
			return `<text x="0" y="${y + 13}" class="lbl">${esc(r.label.length > 34 ? `${r.label.slice(0, 33)}…` : r.label)}</text><rect x="${labelW}" y="${y}" width="${w}" height="${h}" class="bar"/><text x="${labelW + w + 6}" y="${y + 13}" class="val">${esc(r.note ?? num(r.value))}</text>`;
		})
		.join("");
	return `<svg role="img" width="${width}" height="${rows.length * (h + 4)}" viewBox="0 0 ${width} ${rows.length * (h + 4)}">${body}</svg>`;
}

function columns(days: string[], values: number[], width = 720, height = 120): string {
	if (!days.length) return `<p class="empty">—</p>`;
	const max = Math.max(...values, 1);
	const w = Math.max(2, Math.floor(width / days.length) - 1);
	const body = values
		.map((v, i) => {
			const bh = Math.round(((height - 16) * v) / max);
			return `<rect x="${i * (w + 1)}" y="${height - 14 - bh}" width="${w}" height="${bh}" class="bar"><title>${esc(days[i])}: ${esc(num(v))}</title></rect>`;
		})
		.join("");
	const axis = `<text x="0" y="${height - 2}" class="val">${esc(days[0])}</text><text x="${width}" y="${height - 2}" class="val" text-anchor="end">${esc(days.at(-1))}</text>`;
	return `<svg role="img" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}${axis}</svg>`;
}

function table(head: string[], rows: (string | number)[][]): string {
	if (!rows.length) return `<p class="empty">—</p>`;
	return `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${typeof c === "number" ? esc(num(c)) : c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

export function renderHtml(model: ReportModel, lang: Lang = "zh"): string {
	const tx = (t: Text | undefined) => esc(t ? t[lang] : "");
	const m = model.meta.metrics;
	const explain = (id: string) => {
		const meta = m[id];
		if (!meta) return "";
		const dir = meta.goodDirection === "higher" ? (lang === "zh" ? "越高越好" : "higher is better") : meta.goodDirection === "lower" ? (lang === "zh" ? "越低越好" : "lower is better") : "";
		return `<p class="meaning"><b>${tx(meta.label)}</b>: ${tx(meta.meaning)}${dir ? ` <span class="dir">(${dir})</span>` : ""}<br><span class="how">${tx(meta.howComputed)}</span></p>`;
	};
	const L = (en: string, zh: string) => (lang === "zh" ? zh : en);
	const sections: string[] = [];

	const fresh = model.freshness;
	sections.push(`<section><h2>${L("Overview", "總覽")}</h2>
<p>${L("Window", "期間")}: ${esc(model.window.since ?? "—")} → ${esc(model.window.until ?? "—")} (${model.window.days} ${L("days", "天")})${model.window.project ? ` · ${L("project", "專案")} ${esc(model.window.project)}` : ""}</p>
<p class="${fresh.stale ? "warn" : ""}">${L("Last extract", "上次抽取")}: ${esc(fresh.lastExtract ?? "—")}${fresh.stale ? ` — ${L("data is stale; run /evals extract", "資料過時，請執行 /evals extract")}` : ""}</p>
${table([L("Number", "數字"), L("Value", "數值")], [
		[tx(m.sessions.label), model.totals.sessions],
		[tx(m.subagent_sessions.label), model.totals.subagentSessions],
		[tx(m.prompts.label), model.totals.prompts],
		[tx(m.tool_calls.label), model.totals.toolCalls],
		[tx(m.tool_error_rate.label), `${pct(model.totals.toolErrorRate)} (n=${num(nOf(model.totals.toolErrorRate))})`],
		[tx(m.cost.label), usd(model.totals.cost)],
	])}
${explain("sessions")}
<h3>${L("Sessions per day", "每日工作階段")}</h3>${columns(model.series.days, model.series.sessions)}
<h3>${L("Cost per day (USD)", "每日費用（美元）")}</h3>${columns(model.series.days, model.series.cost)}</section>`);

	const sk = model.skills;
	sections.push(`<section><h2>${L("Skills", "技能")}</h2>${explain("skill_loads")}
<h3>${L("Loads per day", "每日載入")}</h3>${columns(model.series.days, model.series.skillLoads)}
<h3>${L("Most loaded", "最常載入")}</h3>${bars(sk.top.slice(0, 25).map((s) => ({ label: s.name, value: s.loads, note: `${num(s.loads)} · ${num(s.sessions)} ${L("sessions", "階段")}` })))}
${explain("skill_sessions")}
<h3>${L("How skills were loaded", "載入方式")}</h3>${table([L("Way", "方式"), L("Loads", "次數")], Object.entries(sk.triggers).map(([k, v]) => [esc(k), v]))}
<h3>${L("By project (top 30)", "各專案（前 30）")}</h3>${table([L("Project", "專案"), L("Skill", "技能"), L("Loads", "次數")], sk.byProject.slice(0, 30).map((r) => [esc(r.project), esc(r.skill), r.loads]))}
<h3>${tx(m.never_loaded.label)} (${sk.neverLoaded.length} / ${sk.offered})</h3>${explain("never_loaded")}<p>${sk.neverLoaded.map(esc).join(", ") || "—"}</p></section>`);

	sections.push(`<section><h2>${L("Packages", "套件")}</h2>${explain("package_calls")}${explain("tool_error_rate")}${explain("avg_duration_ms")}
${table([L("Package", "套件"), L("Version", "版本"), L("Calls", "呼叫"), L("Errors", "錯誤"), tx(m.tool_error_rate.label), tx(m.avg_duration_ms.label)], model.packages.map((p) => [esc(p.owner), esc(p.version ?? "—"), p.calls, p.errors, pct(p.errorRate), ms(p.avgMs)]))}
<h3>${L("Tools (top 40)", "工具（前 40）")}</h3>${table([L("Tool", "工具"), L("Package", "套件"), L("Calls", "呼叫"), tx(m.tool_error_rate.label), tx(m.avg_duration_ms.label)], model.tools.slice(0, 40).map((t) => [esc(t.name), esc(t.owner), t.calls, pct(t.errorRate), ms(t.avgMs)]))}</section>`);

	const ask = model.askUser;
	const bucketLabel = (up: number | null, i: number, all: { upToMs: number | null }[]) => (up === null ? `≥ ${ms(all[i - 1]?.upToMs ?? 0)}` : `< ${ms(up)}`);
	sections.push(`<section><h2>${L("Questions to you", "問你的問題")}</h2>${explain("ask_calls")}${explain("ask_wait_ms")}${explain("ask_cancel_rate")}
${table([L("Number", "數字"), L("Value", "數值")], [
		[tx(m.ask_calls.label), ask.calls],
		[tx(m.ask_wait_ms.label), `${ms(ask.avgWaitMs)} (n=${num(ask.waitN)})`],
		[tx(m.ask_cancel_rate.label), `${pct(ask.cancelRate)} (n=${num(nOf(ask.cancelRate))})`],
	])}
<h3>${L("How long you took", "你花多久回答")}</h3>${bars(ask.buckets.map((b, i) => ({ label: bucketLabel(b.upToMs, i, ask.buckets), value: b.n })))}
<h3>${L("Where the answer came from", "回答來源")}</h3>${table([L("Source", "來源"), L("Questions", "題數")], Object.entries(ask.sources).map(([k, v]) => [esc(k), v]))}</section>`);

	const mon = model.monitors;
	sections.push(`<section><h2>${L("Background jobs", "背景工作")}</h2>${explain("monitor_outcomes")}${explain("monitor_duration_ms")}
<p>${L("Started", "啟動")}: ${num(mon.started)} · ${L("Ending recorded", "有結束紀錄")}: ${num(mon.finished)} · ${tx(m.monitor_duration_ms.label)}: ${ms(mon.avgMs)} (n=${num(mon.durationN)})</p>
${bars(Object.entries(mon.statuses).map(([k, v]) => ({ label: k, value: v })))}</section>`);

	const sub = model.subagents;
	sections.push(`<section><h2>${L("Subagents", "子代理")}</h2>${explain("subagent_launches")}
${table([L("Role", "角色"), L("Model", "模型"), L("Launches", "次數")], sub.launches.slice(0, 40).map((r) => [esc(r.role), esc(r.model), r.n]))}
${explain("subagent_cost")}${bars(sub.costByRole.slice(0, 20).map((r) => ({ label: r.role, value: r.cost, note: usd(r.cost) })))}
<p>${L("Subagent sessions linked to a parent", "能對回母工作階段的子代理")}: ${num(sub.linked)} / ${num(sub.subagentTotal)}</p></section>`);

	const proc = model.process;
	const dm = model.meta.detectors;
	sections.push(`<section><h2>${L("Process: does the work follow the anchorloop rules?", "流程：工作有沒有照 anchorloop 規則走？")}</h2>
<p>${L(`Only sessions from ${proc.eraStart} (anchorloop 3.0.0) on are judged; older ones are out of scope, not failures.`, `只評 ${proc.eraStart}（anchorloop 3.0.0）之後的工作階段；更早的不在範圍內，不算失敗。`)}</p>${explain("pass_rate")}
${proc.detectors
	.map((d) => {
		const meta = dm[d.name];
		const daily = d.perDay.map((x) => (x.pass + x.fail ? Math.round((100 * x.pass) / (x.pass + x.fail)) : 0));
		return `<div class="detector"><h3>${tx(meta?.label)}: ${pct(d.passRate)} <small>(n=${num(nOf(d.passRate))}, ${L("not applicable", "不適用")} ${num(d.na)})</small></h3>
<p>${tx(meta?.meaning)}<br><span class="how">${tx(meta?.howComputed)}</span></p>
<p class="ex">✔ ${tx(meta?.example.pass)}<br>✘ ${tx(meta?.example.fail)}</p>
<h4>${L("Share followed per day (%)", "每日遵守比例（%）")}</h4>${columns(model.series.days, daily, 720, 80)}
${table([L("anchorloop version", "anchorloop 版本"), L("Followed", "遵守"), L("Not followed", "未遵守"), tx(m.pass_rate.label)], d.byVersion.map((v) => [esc(v.version), v.pass, v.fail, pct(v.passRate)]))}</div>`;
	})
	.join("")}
<h3>${L("Close-guard reminders", "收尾提醒")}</h3>${table([L("Kind", "種類"), L("Count", "次數")], Object.entries(proc.notices).map(([k, v]) => [tx(model.meta.notices[k]) || esc(k), v]))}</section>`);

	sections.push(`<section><h2>${L("Cost", "費用")}</h2>${explain("cost")}${explain("cost_per_session")}${explain("skill_cost")}
<p>${tx(m.cost_per_session.label)}: ${model.cost.perSession.value === null ? "—" : usd(model.cost.perSession.value)} (n=${num(model.cost.perSession.n)})</p>
<h3>${L("By skill loaded (top 25)", "依載入技能（前 25）")}</h3>${bars(model.cost.bySkill.map((r) => ({ label: r.skill, value: r.cost, note: `${usd(r.cost)} · ${num(r.sessions)}` })))}
<h3>${L("Model replies by model", "各模型回覆數")}</h3>${table([L("Model", "模型"), L("Replies", "回覆")], model.cost.byModel.slice(0, 20).map((r) => [esc(r.model), r.replies]))}</section>`);

	const changes = model.changes.slice(-40).reverse();
	const imp = (c: (typeof model.changes)[number]) => {
		if (!c.impact) return L("no data before this change", "變更前沒有資料");
		const i = c.impact;
		const row = (key: keyof typeof i.before, label: string) => {
			const b = i.before[key] as Rate | number | undefined;
			const a = i.after[key] as Rate | number | undefined;
			if (b === undefined || a === undefined) return "";
			const show = (x: Rate | number) => (typeof x === "number" ? num(x) : key === "cost_per_session" ? (x.value === null ? "—" : usd(x.value)) : key.endsWith("per_session") ? (x.value === null ? "—" : x.value.toFixed(2)) : pct(x));
			return `<tr><td>${esc(label)}</td><td>${show(b)}</td><td>${show(a)}</td></tr>`;
		};
		const flags = [i.smallSample ? `<span class="warn">${tx(m.small_sample.label)}</span>` : "", i.confounded ? `<span class="warn">${tx(m.confounded.label)}: ${i.confounded}</span>` : ""].filter(Boolean).join(" · ");
		return `<table><thead><tr><th></th><th>${L("before", "之前")}</th><th>${L("after", "之後")}</th></tr></thead><tbody>${row("sessions", tx(m.sessions.label))}${row("tool_error_rate", tx(m.tool_error_rate.label))}${row("package_error_rate", L("This package's error rate", "此套件出錯比例"))}${row("ask_cancel_rate", tx(m.ask_cancel_rate.label))}${row("cost_per_session", tx(m.cost_per_session.label))}${row("skill_loads_per_session", tx(m.skill_loads_per_session.label))}${row("notices_per_session", tx(m.notices_per_session.label))}${row("anchor_before_first_edit", tx(dm.anchor_before_first_edit.label))}${row("check_after_last_edit", tx(dm.check_after_last_edit.label))}</tbody></table>${flags}`;
	};
	sections.push(`<section><h2>${L("Your changes and what followed", "你的變更與之後的變化")}</h2>${explain("impact")}${explain("small_sample")}${explain("confounded")}
${changes.map((c) => `<details><summary>${esc(c.at.slice(0, 10))} · ${tx(model.meta.changeKinds[c.kind])} · ${esc(c.package ? `${c.package} ${c.from ?? "∅"} → ${c.to ?? "∅"}` : c.subject)}${c.repo ? ` <small>${esc(c.repo)} ${esc(c.sha ?? "")}</small>` : ""}</summary><p>${esc(c.subject)}</p>${imp(c)}</details>`).join("") || `<p class="empty">—</p>`}</section>`);

	const lab = model.labels;
	sections.push(`<section><h2>${L("Your labels", "你的標記")}</h2>${explain("agreement")}
${lab.present ? table([L("Check", "檢查"), L("Labelled", "已標記"), L("Agree", "一致"), tx(m.agreement.label)], lab.agreement.map((a) => [tx(dm[a.detector]?.label) || esc(a.detector), a.n, a.agree, pct(a.rate)])) : `<p class="empty">${L("No labels yet. Labelling sessions comes in a later phase.", "還沒有標記。標記工作階段會在之後的階段加入。")}</p>`}</section>`);

	const cov = model.coverage;
	if (cov)
		sections.push(`<section><h2>${tx(m.coverage.label)}</h2>${explain("coverage")}
<p>${L(`Inactive more than ${cov.cutDays} days`, `閒置超過 ${cov.cutDays} 天`)}: ${num(cov.old.files)} ${L("files", "個檔案")} (${(cov.old.bytes / 1e9).toFixed(2)} GB) · ${L("indexed", "已建索引")} ${num(cov.indexed.files)} · ${L("not indexed", "未建索引")} ${num(cov.notIndexed.files)} (${(cov.notIndexed.bytes / 1e9).toFixed(2)} GB)</p></section>`);

	return `<!doctype html><html lang="${lang === "zh" ? "zh-Hant-TW" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>pi-evals report</title>
<style>
:root{color-scheme:light dark;--fg:#1d1d1f;--bg:#fff;--muted:#666;--bar:#4a7bd0;--line:#ddd;--warn:#b35c00}
@media (prefers-color-scheme:dark){:root{--fg:#e6e6e6;--bg:#151515;--muted:#9a9a9a;--bar:#7aa2f7;--line:#333;--warn:#f0a050}}
body{font:15px/1.55 system-ui,-apple-system,"PingFang TC","Noto Sans TC",sans-serif;color:var(--fg);background:var(--bg);max-width:980px;margin:2rem auto;padding:0 1rem}
section{border-top:1px solid var(--line);padding:1rem 0}h1{font-size:1.6rem}h2{font-size:1.3rem}h3{font-size:1.05rem;margin-top:1.2rem}
table{border-collapse:collapse;margin:.5rem 0}td,th{border-bottom:1px solid var(--line);padding:.25rem .6rem;text-align:left;vertical-align:top}
.bar{fill:var(--bar)}.lbl,.val{fill:var(--fg);font-size:12px}.meaning{color:var(--fg)}.how,.dir,small{color:var(--muted)}.warn{color:var(--warn)}.empty{color:var(--muted)}
.ex{color:var(--muted);font-size:.92em}details{margin:.3rem 0}summary{cursor:pointer}
</style></head><body><h1>pi-evals</h1><p class="how">${L("Generated", "產生時間")} ${esc(model.generated)} · ${L("numbers only: no transcript text is stored or shown", "只有數字：不儲存也不顯示對話內容")}</p>${sections.join("\n")}</body></html>`;
}
