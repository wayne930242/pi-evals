import type { ReportModel } from "../model.ts";
import { concepts, lesson } from "./concepts.ts";
import { finding, type Reading, readings, select, value, verdict } from "./findings.ts";
import { type Change, esc, type Lang, num, stamp, title, type Words, words } from "./format.ts";
import type { Week } from "./week.ts";

function card(c: Change, id: string, rs: Reading[], L: Words) {
	const i = c.impact;
	return `<article class="card"><p class="eyebrow"><time datetime="${esc(c.at)}">${esc(stamp(c.at))} UTC</time></p><h3>${
		esc(title(c))
	}</h3>${
		rs.map((r) =>
			`<div class="reading"><b>${esc(r.label)}　${value(r, "before")} → ${value(r, "after")}</b><small>${num(r.before?.n ?? 0)} → ${
				num(r.after?.n ?? 0)
			} ${r.unit}</small></div>`
		).join("")
	}<p class="muted">${
		rs[0].direction === rs[1].direction
			? L(`Both: ${rs[0].direction}.`, `兩項都${rs[0].direction}。`)
			: rs.map((r) => `${r.label}：${r.direction}`).join(" · ")
	}${i ? ` ${num(i.before.sessions)} → ${num(i.after.sessions)} ${L("sessions.", "段工作。")}` : ""}<br><span class="verdict">${
		esc(verdict(c, rs, L))
	}</span></p><a class="button" href="#${id}">${L("Change details", "看調整明細")}　→</a></article>`;
}
function ruler(c: Change, last: string | null, L: Words) {
	const i = c.impact!;
	const cutoff = last && last > c.at && last < i.window.after.until ? last : null;
	const points = [
		[i.window.before.since, L("Before starts", "開始算調整前")],
		[c.at, L("Change", "做了調整")],
		...(cutoff ? [[cutoff, L("Last extract", "資料截至這裡")]] : []),
		[i.window.after.until, L("After window ends", "調整後期間結束")],
	];
	return `<div class="ruler-head"><h2>${
		L(`Compare ${i.window.days} days on each side`, `同一條規則，前後各看 ${i.window.days} 天`)
	}</h2><small>${L("Grouped by start time · not to scale", "依工作開始時間分組　／　時間線不按比例繪製")}</small></div><ol class="ruler${
		cutoff ? " partial" : ""
	}">${points.map(([at, text]) => `<li><time>${esc(stamp(at))}</time><i></i><span>${text}</span></li>`).join("")}</ol>`;
}
function panel(c: Change, side: "before" | "after", rs: Reading[], period: string, L: Words) {
	const i = c.impact!;
	return `<article class="panel compare ${side}"><p class="eyebrow">${
		side === "before" ? L("Before", "調整前") : L("After", "調整後")
	}　／　${esc(period)}</p><h3>${num(i[side].sessions)} ${L("sessions", "段工作")}</h3>${
		rs.map((r) => {
			const x = r[side];
			const sample = x?.value != null
				? (r.key === "cost_per_session" ? `${num(x.n)} ${r.unit}` : `${num(Math.round(x.value * x.n))} / ${num(x.n)} ${r.unit}`)
				: L("no eligible records", "沒有適用紀錄");
			return `<div class="reading"><span>${esc(r.label)}</span><b>${value(r, side)} <small>（${sample}）</small></b></div>`;
		}).join("")
	}</article>`;
}
function detail(c: Change, id: string, rs: Reading[], m: ReportModel, w: Week, lang: Lang, siblings: Change[]) {
	const L = words(lang), i = c.impact, lessons = concepts(m, w, c, L);
	const peers = siblings.filter((s) => s !== c);
	const together = peers.length
		? L(
			`Same commit: ${peers.map((s) => s.package ?? m.meta.changeKinds[s.kind][lang]).join(", ")}.`,
			`同一次提交也調整了 ${peers.map((s) => s.package ?? m.meta.changeKinds[s.kind][lang]).join("、")}。`,
		)
		: "";
	const primary = rs[0];
	const age = (Date.parse(m.freshness.lastExtract ?? "") - Date.parse(c.at)) / 3600000;
	const partial = i?.incomplete && age >= 0 && age < i.window.days * 24;
	const ageText = age < 1 ? L("less than an hour", "不到一小時") : L(`about ${Math.floor(age)} hours`, `約 ${Math.floor(age)} 小時`);
	const heading = partial ? L(`Only ${ageText} since the change: too early to tell`, `調整後${ageText}，還看不出效果`) : verdict(c, rs, L);
	const fullPeriod = L(`${i?.window.days} days`, `${i?.window.days} 天`);
	const beforePeriod = i?.incomplete ? L(`Planned: ${fullPeriod}`, `原定 ${fullPeriod}`) : fullPeriod;
	return `<section class="detail" id="${id}" tabindex="-1"><div class="hero"><a class="back" href="#timeline">← ${
		L("Timeline", "回時間軸")
	}</a><p class="eyebrow">${L("Architecture change", "架構調整明細")}　／　${esc(stamp(c.at))} UTC</p><h2 class="hero-title">${
		esc(heading)
	}</h2><p class="deck">${esc(title(c))}　${esc(together)}</p>${
		i
			? `<p class="deck">${esc(primary.label)}：${value(primary, "before")} → ${value(primary, "after")}。 ${esc(verdict(c, rs, L))}</p>`
			: ""
	}</div>
${
		i
			? `${ruler(c, m.freshness.lastExtract, L)}<p class="eyebrow">${L("Records side by side", "紀錄對照")}</p><h2>${
				L("Compare the two groups", "比較兩個時段的工作")
			}</h2><div class="pair">${panel(c, "before", rs, beforePeriod, L)}${
				panel(c, "after", rs, partial ? ageText : fullPeriod, L)
			}</div><p>${rs.map((r) => `${esc(r.label)}：${r.direction}`).join("　／　")}</p>`
			: ""
	}
<div class="notes-grid">${lesson(lessons.sample, L)}${lesson(lessons.confounding, L)}${
		c.package === "pi-anchorloop" ? lesson(lessons.check, L) : ""
	}</div><p class="muted">${esc(c.repo)} ${esc(c.sha)}　${esc(c.subject)}</p><a href="#timeline">← ${
		L("Timeline", "回時間軸")
	}</a></section>`;
}
export function timeline(m: ReportModel, w: Week, lang: Lang) {
	const L = words(lang), { all, lead, highlighted, folded } = select(m);
	const ids = new Map(all.map((c, i) => [c, `change-${i + 1}`]));
	const metrics = new Map(all.map((c) => [c, readings(c, m, lang)]));
	const byDay = new Map<string, Change[]>(), byCommit = new Map<string, Change[]>();
	for (const c of folded) {
		const d = c.at.slice(0, 10);
		if (!byDay.has(d)) byDay.set(d, []);
		byDay.get(d)!.push(c);
	}
	for (const c of all) {
		if (c.sha) {
			const key = `${c.repo}/${c.sha}`;
			if (!byCommit.has(key)) byCommit.set(key, []);
			byCommit.get(key)!.push(c);
		}
	}
	const headline = lead
		? finding(lead, metrics.get(lead)!, L)
		: all.length
		? L("Not enough sessions to compare changes yet", "這批調整的工作段數還不夠比較")
		: L("No changes recorded in this period", "這段期間沒有調整紀錄");
	const reason = lead?.impact;
	const trust = lead && reason?.incomplete && reason.confounded && !reason.smallSample
		? L(
			`There were ${
				num(reason.confounded)
			} other changes, and one side has less than ${reason.window.days} days of data. We cannot credit this change alone.`,
			`同期還有 ${num(reason.confounded)} 筆別的調整，一側的資料也未滿 ${reason.window.days} 天；目前不能把差異歸給這次調整。`,
		)
		: lead
		? verdict(lead, metrics.get(lead)!, L)
		: L(
			`There are ${num(m.totals.sessions)} sessions in this report, but no eligible comparison.`,
			`報表收錄 ${num(m.totals.sessions)} 段工作，目前沒有適合放在首頁的比較。`,
		);
	return {
		lead,
		headline,
		trust,
		count: highlighted.length,
		cards: highlighted.map((c) => card(c, ids.get(c)!, metrics.get(c)!, L)).join(""),
		archive: [...byDay].map(([day, list]) =>
			`<details class="day"><summary>${esc(day)}　／　${num(list.length)} ${L("changes", "筆調整")}</summary><ul>${
				list.map((c) => `<li><time>${esc(c.at.slice(11, 16))}</time>　<a href="#${ids.get(c)}">${esc(title(c))}</a></li>`).join("")
			}</ul></details>`
		).join(""),
		details: all.map((c) => detail(c, ids.get(c)!, metrics.get(c)!, m, w, lang, byCommit.get(`${c.repo}/${c.sha}`) ?? [])).join(""),
	};
}
