/** The 「工作」 section: one row per work item, a like-with-like comparison, and the items still open. */
import type { ReportModel } from "../model.ts";
import type { Comparison, Verdict, WorkModel } from "../work/model.ts";
import { esc, type Lang, num, usd, type Words, words } from "./format.ts";

const SHOWN = 15;

export function span(minutes: number, L: Words) {
	if (minutes < 90) return L(`${Math.round(minutes)} min`, `${Math.round(minutes)} 分`);
	if (minutes < 48 * 60) return L(`${(minutes / 60).toFixed(1)} h`, `${(minutes / 60).toFixed(1)} 小時`);
	return L(`${(minutes / 1440).toFixed(1)} days`, `${(minutes / 1440).toFixed(1)} 天`);
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function verdictText(c: Comparison, v: Verdict, L: Words, lines = false) {
	const g = (value?: string) => c.groups.find((x) => x.value === value);
	const n = (value?: string) => (lines ? g(value)?.nLines : g(value)?.n) ?? 0;
	const what = lines ? L("per 100 changed lines", "每百行") : L("per item", "每件");
	if (v.kind === "single") return v.a ? L(`Only one group (${v.a}): nothing to compare it with.`, `只有一組（${v.a}），沒有可比的對象。`) : L("No items with a line count.", "沒有算得出行數的工作。");
	if (v.kind === "few") return L(`Too few items to tell yet (${v.a} ${n(v.a)}, ${v.b} ${n(v.b)}; each group needs 5).`, `件數太少，還看不出來（${v.a} ${n(v.a)} 件、${v.b} ${n(v.b)} 件，每組至少要 5 件）。`);
	if (v.kind === "same") return L(`${v.a} and ${v.b} cost about the same ${what} (less than 20% apart).`, `${v.a} 和 ${v.b} ${what}花費差不到兩成，看不出差別。`);
	return L(`${v.a} costs ${pct(v.by ?? 0)} less ${what} than ${v.b} (median of ${n(v.a)} and ${n(v.b)} items of the same kind). This is a difference, not its cause.`, `${v.a} ${what}比 ${v.b} 便宜 ${pct(v.by ?? 0)}（同類工作的中位數，各 ${n(v.a)}、${n(v.b)} 件）。這是差異，不是原因。`);
}

function stallText(stalls: Record<string, number>, m: ReportModel, lang: Lang) {
	const L = words(lang);
	const parts = Object.entries(stalls)
		.sort((a, b) => b[1] - a[1])
		.map(([k, v]) => `${m.meta.stallKinds[k]?.[lang] ?? k} ${span(v, L)}`);
	return parts.join(L(", ", "、")) || "—";
}

export function workSection(m: ReportModel, lang: Lang, cards: { attribution: string[]; cheaper: string[] }, lesson: (c: string[], L: Words) => string) {
	const L = words(lang);
	const w = m.work;
	const head = `<section id="work" class="topic"><p class="eyebrow">PI-EVALS　／　${L("Work items", "工作")}</p><h2>${L("Work items: what each cost, where it closed, where it stalled", "工作：每一項花多少、在哪裡收尾、卡在哪裡")}</h2>`;
	if (!w) return `${head}<p class="intro">${L("Run /evals extract to build the work items.", "請執行 /evals extract 建立工作項目。")}</p></section>`;
	const meta = m.meta.metrics;
	const close = (k: string) => m.meta.closeKinds[k]?.[lang] ?? k;
	const dims: Record<string, string> = { role: L("role", "角色"), model: L("model", "模型"), anchorloop: L("anchorloop version", "anchorloop 版本") };
	const kinds: Record<string, string> = { delegated: L("Work handed to subagents", "交給子代理做的工作"), self: L("Work the main agent did itself", "主代理自己做的工作") };
	const stallTotal = Object.values(w.stallMs).reduce((s, v) => s + v, 0);
	const row = (r: WorkModel["list"][number]) =>
		`<tr><td class="item-title">${esc(r.title || r.key)}</td><td>${esc(r.owner ?? "—")}</td><td class="nowrap">${usd(r.main + r.child)}<small>${r.child > 0 ? `${L("main", "主")} ${usd(r.main)}＋${L("sub", "子")} ${usd(r.child)}` : L("main agent only", "只有主代理")}</small></td><td class="nowrap">${esc(span(r.minutes, L))}</td><td>${esc(close(r.closeKind))}${r.thread ? `<small>${esc(r.thread)}</small>` : ""}</td><td>${esc(stallText(r.stalls, m, lang))}</td></tr>`;
	const listHead = `<thead><tr><th scope="col">${L("Item", "工作")}</th><th scope="col">${L("Owner", "誰做")}</th><th scope="col">${L("Cost (main + subagents)", "花費（主＋子）")}</th><th scope="col">${L("In progress", "進行")}</th><th scope="col">${L("Closed by", "收尾方式")}</th><th scope="col">${L("Stalls", "停頓")}</th></tr></thead>`;
	const list = w.list.length
		? `<div class="scroll"><table class="items">${listHead}<tbody>${w.list.slice(0, SHOWN).map(row).join("")}</tbody></table></div>${
			w.list.length > SHOWN ? `<details><summary>${L(`${w.list.length - SHOWN} more`, `再看 ${w.list.length - SHOWN} 項`)}</summary><div class="scroll"><table class="items">${listHead}<tbody>${w.list.slice(SHOWN).map(row).join("")}</tbody></table></div></details>` : ""
		}`
		: `<p class="muted">${L("No item closed in this period.", "這段期間沒有收尾的工作。")}</p>`;
	const compare = w.compare.length
		? w.compare
			.map(
				(c) =>
					`<article class="panel"><h3>${esc(kinds[c.kind])}　／　${L("by", "依")}${esc(dims[c.dimension])}</h3><div class="scroll"><table><thead><tr><th scope="col">${esc(dims[c.dimension])}</th><th scope="col">${L("Items", "件數")}</th><th scope="col">${L("Median per item", "每件中位數")}</th><th scope="col">${L("Per 100 lines (items)", "每百行（件數）")}</th></tr></thead><tbody>${
						c.groups.map((g) => `<tr><td>${esc(g.value)}</td><td>${num(g.n)}</td><td>${usd(g.median)}</td><td>${g.per100 === null ? "—" : `${usd(g.per100)}（${num(g.nLines)}）`}</td></tr>`).join("")
					}</tbody></table></div><p class="verdict">${esc(verdictText(c, c.verdict, L))}</p><p class="muted">${esc(verdictText(c, c.verdictLines, L, true))}</p></article>`,
			)
			.join("")
		: `<p class="muted">${L("No finished items to compare.", "沒有可比較的已完成工作。")}</p>`;
	const open = w.open.length
		? `<div class="scroll"><table class="items"><thead><tr><th scope="col">${L("Item", "工作")}</th><th scope="col">${L("Stopped at", "停在哪")}</th><th scope="col">${L("Waiting on", "等誰")}</th><th scope="col">${L("For how long", "多久")}</th></tr></thead><tbody>${
			w.open
				.map((o) => `<tr><td class="item-title">${esc(o.title || o.key)}</td><td>${esc(m.meta.stallKinds[o.kind]?.[lang] ?? o.kind)}</td><td>${esc(o.on ?? (o.kind === "human" ? L("you (next prompt)", "你（下一個指示）") : "—"))}${o.owner && o.owner !== o.on ? `<small>${esc(o.owner)}</small>` : ""}</td><td>${esc(span(o.waitMinutes, L))}<small>${L("since", "自")} ${esc(o.since.slice(5, 16).replace("T", " "))} UTC</small></td></tr>`)
				.join("")
		}</tbody></table></div>`
		: `<p class="muted">${L("Nothing open in this period.", "這段期間沒有還開著的工作。")}</p>`;
	const tile = (label: string, big: string, note: string) => `<article class="panel"><p class="eyebrow">${esc(label)}</p><p class="big">${big}</p><p class="muted">${note}</p></article>`;
	const kindRows = Object.entries(w.closeKinds).filter(([, n]) => n > 0).map(([k, n]) => `${esc(close(k))} ${num(n)}`).join(L(", ", "、"));
	return `${head}<p class="intro">${
		L(
			"A work item is one todo task, from the moment it was switched to in progress until it was marked done or deleted. Time spent waiting in the queue before that does not count.",
			"一項工作就是待辦清單上的一列：從它被切到「進行中」開始，到標成完成或刪除為止。開始前排隊的時間不算。",
		)
	}</p><div class="tiles">${
		tile(L("Items", "件數"), num(w.completed), L(`finished; ${num(w.inProgress)} in progress, ${num(w.pending)} not started, ${num(w.deleted)} deleted`, `件完成；進行中 ${num(w.inProgress)}、還沒開始 ${num(w.pending)}、刪掉 ${num(w.deleted)}`))
	}${
		tile(L("Cost of finished items", "完成工作的總花費"), usd(w.cost.main + w.cost.child), L(`subagents ${usd(w.cost.child)} (exact) + main ${usd(w.cost.main)} (estimated)`, `子代理 ${usd(w.cost.child)}（精確）＋主代理 ${usd(w.cost.main)}（估算）`))
	}${
		tile(L("Median item", "每件中位數"), usd(w.cost.median), L(`${w.cost.medianMinutes === null ? "—" : span(w.cost.medianMinutes, L)} in progress`, `進行 ${w.cost.medianMinutes === null ? "—" : span(w.cost.medianMinutes, L)}`))
	}${
		tile(meta.item_stall.label[lang], span(stallTotal / 60_000, L), L(`of ${span(w.activeMs / 60_000, L)} in progress`, `占進行中 ${span(w.activeMs / 60_000, L)}`) + "<br>" + esc(stallText(Object.fromEntries(Object.entries(w.stallMs).filter(([, v]) => v > 0).map(([k, v]) => [k, v / 60_000])), m, lang)))
	}</div><p class="muted">${L("How items closed", "收尾方式")}：${kindRows || "—"}</p><h3>${L("Latest finished items", "最近完成的工作")}</h3>${list}<p class="muted">${esc(meta.item_stall.howComputed[lang])}</p><div class="pair">${lesson(cards.attribution, L)}${lesson(cards.cheaper, L)}</div><h3>${L("Is one way cheaper?", "有沒有比較省？")}</h3><p class="intro">${
		L("Each panel compares only items of the same kind; a group needs at least 5 items.", "每一格只比同一類的工作；每組至少 5 件才下結論。")
	}</p><div class="pair">${compare}</div><h3>${L("Still open: stopped where, waiting on whom, for how long", "還開著的工作：停在哪、等誰、多久")}</h3>${open}</section>`;
}
