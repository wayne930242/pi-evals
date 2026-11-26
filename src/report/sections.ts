import { FAILURE_TYPE_META, type FailureType, ruleLabel } from "../labels.ts";
import { type ReportModel, SMALL_SAMPLE } from "../model.ts";
import { type concepts, lesson, selfCheck } from "./concepts.ts";
import { duration, esc, type Lang, num, pct, table, usd, words } from "./format.ts";
import { workSection } from "./work.ts";

export function sections(m: ReportModel, lang: Lang, cards: ReturnType<typeof concepts>) {
	const L = words(lang), meta = m.meta.metrics;
	const label = (id: string) => meta[id].label[lang];
	const T = (head: string[], rows: (number | string)[][]) => table(head, rows, L);
	const section = (id: string, title: string, intro: string, body: string) =>
		`<section id="${id}" class="topic"><p class="eyebrow">PI-EVALS　／　${
			L("Field notes", "工作紀錄")
		}</p><h2>${title}</h2><p class="intro">${esc(intro)}</p>${body}</section>`;
	const more = (title: string, html: string) => `<details><summary>${esc(title)}</summary>${html}</details>`;
	const daily = (values: number[]) => T([L("Date (UTC)", "日期（UTC）"), L("Value", "數值")], m.series.days.map((d, i) => [d, values[i]]));
	const entries = (map: Record<string, number>) => Object.entries(map);
	const sk = m.skills, a = m.askUser, mon = m.monitors, s = m.subagents;
	const skills = section(
		"skills",
		L("Which skills got opened?", "哪些技能真的有人打開？"),
		meta.skill_loads.meaning[lang],
		`<div class="pair"><article class="panel"><h3>${L("Most used", "最常載入")}</h3>${
			T([L("Skill", "技能"), L("Loads", "次數"), L("Sessions", "工作段數")], sk.top.slice(0, 8).map((r) => [r.name, r.loads, r.sessions]))
		}</article><article class="panel tint"><h3>${L("Offered but never opened", "有提供，但沒人載入")}</h3><p class="big">${
			num(sk.neverLoaded.length)
		} / ${num(sk.offered)}</p><p>${esc(meta.never_loaded.howComputed[lang])}</p>${
			more(L("Skill names", "看技能名稱"), `<p>${sk.neverLoaded.map(esc).join("、") || "—"}</p>`)
		}</article></div>` +
			more(
				L("Loads by day, project and trigger", "查看每日載入、各專案與載入方式"),
				daily(m.series.skillLoads) +
					T([L("Project", "專案"), L("Skill", "技能"), L("Loads", "次數")], sk.byProject.map((r) => [r.project, r.skill, r.loads])) +
					T([L("Trigger", "方式"), L("Loads", "次數")], entries(sk.triggers)),
			),
	);
	const packages = section(
		"packages",
		L("Packages and tools", "套件與工具"),
		meta.package_calls.meaning[lang],
		T(
			[L("Package", "套件"), L("Version", "版本"), L("Calls", "呼叫次數"), label("tool_error_rate"), label("avg_duration_ms")],
			m.packages.map((r) => [r.owner, r.version ?? "—", r.calls, pct(r.errorRate), duration(r.avgMs)]),
		) +
			more(
				L("Tools by calls", "依呼叫次數查看工具"),
				T(
					[L("Tool", "工具"), L("Package", "套件"), L("Calls", "次數"), label("tool_error_rate")],
					m.tools.map((r) => [r.name, r.owner, r.calls, pct(r.errorRate)]),
				),
			),
	);
	const ask = section(
		"ask",
		L("When the agent stopped to ask", "代理人何時停下來問你"),
		L(
			"See how often you were asked, how long an answer took and how often you dismissed the question.",
			"這裡可以看到代理人問了幾次、答一題平均要等多久，以及你取消了多少提問。",
		),
		T([L("Measure", "指標"), L("Reading", "數值"), L("Counted", "計算次數")], [[label("ask_calls"), a.calls, a.calls], [
			label("ask_wait_ms"),
			duration(a.avgWaitMs),
			a.waitN,
		], [label("ask_cancel_rate"), pct(a.cancelRate), a.cancelRate.n]]) +
			more(
				L("Wait times and answer sources", "查看等待時間分布與回答來源"),
				T(
					[L("Wait", "等待時間"), L("Count", "次數")],
					a.buckets.map((b, i) => [
						b.upToMs == null
							? `≥ ${duration(a.buckets[i - 1]?.upToMs ?? 0)}`
							: `${duration(i ? a.buckets[i - 1].upToMs : 0)} – < ${duration(b.upToMs)}`,
						b.n,
					]),
				) + T([L("Source", "來源"), L("Count", "次數")], entries(a.sources)),
			),
	);
	const monitors = section(
		"monitors",
		L("Background jobs", "背景工作"),
		meta.monitor_outcomes.meaning[lang],
		`<p>${L("Started", "啟動")} ${num(mon.started)}　／　${L("Ending recorded", "有結束紀錄")} ${num(mon.finished)}　／　${
			label("monitor_duration_ms")
		} ${duration(mon.avgMs)}（${num(mon.durationN)}）</p>${
			T([L("Outcome", "結果"), L("Count", "次數")], entries(mon.statuses))
		}<p class="muted">${esc(meta.monitor_outcomes.howComputed[lang])}</p>`,
	);
	const sub = section(
		"subagents",
		L("Work handed to other agents", "交給子代理的工作"),
		meta.subagent_launches.meaning[lang],
		T([L("Role", "角色"), L("Model", "模型"), L("Launches", "啟動次數")], s.launches.slice(0, 40).map((r) => [r.role, r.model, r.n])) +
			more(label("subagent_cost"), T([L("Role", "角色"), L("USD", "美元")], s.costByRole.map((r) => [r.role, usd(r.cost)]))) +
			`<p>${L("Linked to a parent in this period", "這段期間能對回母工作階段的子代理")}：${s.linked === null ? L("Run /evals extract for this breakdown.", "請執行 /evals extract 更新分期統計。") : `${num(s.linked)} / ${num(s.subagentTotal)}`} </p>`,
	);
	const process = section(
		"process",
		L("Did the agent follow the steps?", "工作有沒有照說好的步驟走？"),
		L(
			`Only sessions starting from ${m.process.eraStart} are judged. Earlier work is not a failure.`,
			`只檢查 ${m.process.eraStart} 起的工作；更早的工作不算失敗。`,
		),
		lesson(cards.check, L) + `<div class="pair checks">${
			m.process.detectors.map((d) => {
				const md = m.meta.detectors[d.name];
				return `<article class="panel"><p class="eyebrow">${L("Code check", "程式檢查")}　／　${L("higher is better", "越高越好")}</p><h3>${
					esc(md.label[lang])
				}</h3><p class="big">${pct(d.passRate)} <small>${num(d.pass)} / ${num(d.passRate.n)} ${L("sessions", "段")}</small></p><p>${
					esc(md.howComputed[lang])
				}</p><p><b>${L("Pass", "通過")}</b>　${esc(md.example.pass[lang])}<br><b>${L("Fail", "未通過")}</b>　${
					esc(md.example.fail[lang])
				}</p>${
					more(
						L("By day and version", "查看每日與各版本的通過數"),
						T([L("Day", "日期"), L("Pass", "通過"), L("Fail", "未通過")], d.perDay.map((r) => [r.day, r.pass, r.fail])) +
							T([L("Version", "版本"), L("Pass", "通過"), L("Fail", "未通過")], d.byVersion.map((r) => [r.version, r.pass, r.fail])),
					)
				}</article>`;
			}).join("")
		}</div>` +
			more(
				L("Close-guard reminders", "收尾提醒"),
				T([L("Kind", "種類"), L("Count", "次數")], entries(m.process.notices).map(([k, n]) => [m.meta.notices[k]?.[lang] ?? k, n])),
			),
	);
	const cost = section(
		"cost",
		L("What the work cost", "工作花了多少錢"),
		meta.cost.meaning[lang],
		`<p class="big">${usd(m.cost.total)} <small>USD</small></p><p>${label("cost_per_session")} ${usd(m.cost.perSession.value)}（${
			num(m.cost.perSession.n)
		} ${L("sessions", "段")}）</p><p>${esc(meta.skill_cost.meaning[lang])}</p>` +
			T([L("Skill", "技能"), L("USD", "美元"), L("Sessions", "工作段數")], m.cost.bySkill.map((r) => [r.skill, usd(r.cost), r.sessions])) +
			more(
				L("Daily spend and model replies", "查看每日費用與各模型回覆數"),
				daily(m.series.cost) + T([L("Model", "模型"), L("Replies", "回覆數")], m.cost.byModel.map((r) => [r.model, r.replies])),
			),
	);
	const cov = m.coverage;
	const coverage = section(
		"coverage",
		L("When is cleanup safe?", "何時可以開啟清理？"),
		L(
			"Only consider cleanup when all old files match the index, by both file count and bytes. This report never deletes a file.",
			"所有舊檔的大小和修改時間都要和索引相符，未建索引的檔案數和位元組數都歸零，才考慮開啟清理。報表不會刪檔。",
		),
		cov
			? `<p>${L("Files modified in the selected dates, indexed (all projects)", "選定日期內有修改的檔案，已建索引（全部專案）")}：${num(cov.inRange?.indexed ?? 0)} / ${num(cov.inRange?.files ?? 0)}</p><p>${L("Cleanup gate across all dates", "清理門檻不分日期")} · ${L("Inactive days", "閒置天數")} &gt; ${cov.cutDays}　／　${L("Files indexed", "已建索引")} ${num(cov.indexed.files)} / ${
				num(cov.old.files)
			}</p><p>${L("Not indexed", "未建索引")}：${num(cov.notIndexed.files)} ${L("files", "個檔案")} · ${
				num(cov.notIndexed.bytes)
			} bytes</p>`
			: `<p>${L("Coverage not measured; keep cleanup off.", "沒有索引覆蓋資料，請勿開啟清理。")}</p>`,
	);
	const lb = m.labels, rule = (r: string) => ruleLabel(r, lang);
	const pair = (c: { agree: number; n: number }) => (c.n ? `${num(c.agree)} / ${num(c.n)}` : "—");
	const asked = lb.asks.n
		? `<p>${L(`You asked with /ask-ai ${num(lb.asks.n)} times; ${num(lb.asks.labelled)} of them were followed within 30 minutes by a label in the same session.`, `你用 /ask-ai 問了 ${num(lb.asks.n)} 次，其中 ${num(lb.asks.labelled)} 次在同一段工作裡、30 分鐘內接著標記了。`)}</p>`
		: "";
	const labels = section(
		"labels",
		L("Your labels", "你的標記"),
		meta.agreement.meaning[lang],
		lb.needsIndex ? `<p>${L("Run /evals extract to count labels in this period.", "請執行 /evals extract 以計算這段期間的標記。")}</p>` : lb.present && lb.n
			? `<p>${L(`After the fact ${num(lb.bySource.batch)} (${num(lb.sessions.batch)} sessions)　／　In the moment ${num(lb.bySource.live)} (${num(lb.sessions.live)} sessions)`, `事後標 ${num(lb.bySource.batch)} 筆（${num(lb.sessions.batch)} 段工作）　／　當下標 ${num(lb.bySource.live)} 筆（${num(lb.sessions.live)} 段工作）`)}${
				lb.fromWords ? L(`; ${num(lb.fromWords)} of them the agent wrote from your words`, `；其中 ${num(lb.fromWords)} 筆是代理人依你的話整理的`) : ""
			}</p>` +
				T(
					[L("Check", "檢查"), L("Agreement", "一致比例"), L("After the fact: agreed / compared", "事後標：一致 / 比對"), L("In the moment: agreed / compared", "當下標：一致 / 比對"), L("Cannot tell", "看不出來")],
					lb.agreement.map((r) => [rule(r.detector), `${pct(r.rate)}（${num(r.n)}）`, pair(r.bySource.batch), pair(r.bySource.live), r.unclear]),
				) +
				`<p class="muted">${L(`Cannot tell ${num(lb.unclear)}: labels marked unclear are left out of the agreement rate.`, `看不出來 ${num(lb.unclear)}：標成「看不出來」的不算進一致比例。`)}${
					lb.noCode ? L(` ${num(lb.noCode)} labels have no code verdict to compare: the session is not extracted yet (run /evals extract), or the rule did not apply to it.`, `另有 ${num(lb.noCode)} 筆沒有程式判斷可比：那段工作還沒整理（執行 /evals extract 後就能比），或這條規則不適用於它。`) : ""
				}${lb.other ? L(` ${num(lb.other)} labels are on "Other", which no code check covers.`, `${num(lb.other)} 筆標在「其他」，沒有程式檢查可比。`) : ""}</p>` + asked + lesson(cards.labelTiming, L)
			: `<p>${
				L(
					"No labels yet. Type /evals label in any session to say, while the work is in front of you, whether the agent followed a rule.",
					"還沒有標記。在任何工作階段輸入 /evals label，就能趁工作還在眼前，標記代理人有沒有照規則做。",
				)
			}</p>` + asked + lesson(cards.labelTiming, L),
	);
	const c = lb.corrections, few = c.n < SMALL_SAMPLE;
	const corrections = section(
		"corrections",
		L("Times the agent was corrected", "被糾正"),
		L(
			"When you correct how the agent worked, it logs one line with evals_label. This counts the corrections it logged, not all its mistakes: a slip nobody caught, or one it forgot to log, is not here.",
			"你糾正代理人的做法時，它會用 evals_label 自己記一筆。這裡數的是它記下的被糾正次數，不是所有錯誤：沒人發現、沒被糾正，或它忘了記的，都不在這裡。",
		),
		c.n
			? `<p class="big">${num(c.n)} <small>${L("corrections", "次")} · ${num(c.sessions)} ${L("sessions", "段工作")}</small></p>${
				few ? `<p class="stale">${L(`Only ${num(c.n)}: too few to show a trend. Read it as a hint of where slips may recur.`, `只有 ${num(c.n)} 次，太少，看不出趨勢；只能當提醒，看哪裡可能常出錯。`)}</p>` : ""
			}<div class="pair"><article class="panel"><h3>${L("By rule", "依規則")}</h3>${T([L("Rule", "規則"), L("Times", "次數")], c.byRule.map((r) => [rule(r.rule), r.n]))}</article><article class="panel"><h3>${L("By kind of slip", "依錯誤類型")}</h3>${
				T([L("Kind", "類型"), L("Times", "次數")], c.byType.map((r) => [FAILURE_TYPE_META[r.type as FailureType]?.[lang] ?? r.type, r.n]))
			}</article></div>` +
				more(
					L("By skill loaded and by anchorloop version", "依載入的技能、anchorloop 版本"),
					`<p class="muted">${L("Skills the session had loaded before the correction. One correction counts for each of them; this does not mean the skill caused it.", "被糾正時這段工作已載入的技能。一次糾正會算進每個已載入的技能，不代表是技能造成的。")}</p>` +
						T([L("Skill", "技能"), L("Times", "次數"), L("Sessions", "工作段數")], c.bySkill.map((r) => [r.skill || L("(none loaded)", "（沒載入技能）"), r.n, r.sessions])) +
						`<p class="muted">${L("The anchorloop version in use when the correction was logged.", "依糾正當時使用的 anchorloop 版本。")}</p>` +
						T([L("Version", "版本"), L("Times", "次數"), L("Sessions", "工作段數")], c.byVersion.map((r) => [r.version === "unknown" ? L("unknown", "不明") : r.version, r.n, r.sessions])),
				)
			: `<p>${L("None logged in this period. When you correct the agent, it logs one line here.", "這段期間沒有紀錄。你糾正代理人時，它會在這裡記一筆。")}</p>`,
	);
	return [
		workSection(m, lang, cards, lesson),
		skills,
		packages,
		ask,
		monitors,
		sub,
		process,
		cost,
		coverage,
		labels,
		corrections,
		section(
			"concepts",
			L("Concepts", "概念"),
			L(`Use these ${Object.keys(cards).length} ideas when you read the next report.`, `下次讀報表時，可以用這 ${Object.keys(cards).length} 個概念判讀數字。`),
			`<div class="notes-grid">${Object.values(cards).map((c) => lesson(c, L)).join("")}</div>${selfCheck(L)}`,
		),
	].join("");
}
