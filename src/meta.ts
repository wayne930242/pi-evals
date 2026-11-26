/**
 * Plain-language metadata for every metric and detector, for a reader who is not an evals expert.
 * Data, not markup: the report renderer and `evals_query` both read it. English and Traditional Chinese.
 */
export interface Text {
	en: string;
	zh: string;
}

export interface MetricMeta {
	label: Text;
	/** One sentence: what the number says about the agents' work. */
	meaning: Text;
	goodDirection: "higher" | "lower" | "none";
	/** One sentence, no jargon. */
	howComputed: Text;
}

export interface DetectorMeta extends MetricMeta {
	example: { pass: Text; fail: Text };
}

const t = (en: string, zh: string): Text => ({ en, zh });

export const METRICS: Record<string, MetricMeta> = {
	sessions: {
		label: t("Sessions", "工作階段數"),
		meaning: t("How much agent work happened; every other number should be read against it.", "代理人做了多少工作；其他數字都要對照這個量來看。"),
		goodDirection: "none",
		howComputed: t("Session files and live-only sessions that started in the window, each counted once.", "在期間內開始的工作階段檔與只有即時紀錄的工作階段，各算一次。"),
	},
	subagent_sessions: {
		label: t("Subagent sessions", "子代理工作階段數"),
		meaning: t("How much work was handed to helper agents instead of done by a main agent.", "有多少工作交給輔助代理人，而不是主代理人自己做。"),
		goodDirection: "none",
		howComputed: t("Sessions whose file name marks them as launched by another session.", "檔名顯示由另一個工作階段啟動的工作階段。"),
	},
	prompts: {
		label: t("Prompts", "提示次數"),
		meaning: t("How many times someone (you or another agent) asked an agent to do something.", "你或其他代理人要求代理人做事的次數。"),
		goodDirection: "none",
		howComputed: t("User messages in the session files.", "工作階段檔中的使用者訊息數。"),
	},
	tool_calls: {
		label: t("Tool calls", "工具呼叫次數"),
		meaning: t("How busy the agents were; a sudden jump can mean an agent is going in circles.", "代理人有多忙；突然暴增可能代表代理人在原地打轉。"),
		goodDirection: "none",
		howComputed: t("Finished tool calls, including ones that failed or were blocked.", "已結束的工具呼叫，包括失敗或被擋下的。"),
	},
	tool_error_rate: {
		label: t("Tool error rate", "工具出錯比例"),
		meaning: t("How often a tool call came back as an error; high means wasted turns or a broken tool.", "工具呼叫回報錯誤的頻率；偏高代表浪費回合或工具壞了。"),
		goodDirection: "lower",
		howComputed: t("Calls marked as errors divided by all calls.", "標為錯誤的呼叫數除以全部呼叫數。"),
	},
	avg_duration_ms: {
		label: t("Average time per call", "每次呼叫平均耗時"),
		meaning: t("How long a tool call usually takes; slow tools hold the agent up.", "一次工具呼叫通常花多久；慢的工具會拖住代理人。"),
		goodDirection: "lower",
		howComputed: t("Mean of the measured run time; older calls without a measurement use the time between the call and its result.", "量到的執行時間平均；舊紀錄沒有量測時，用呼叫到結果之間的時間。"),
	},
	skill_loads: {
		label: t("Skill loads", "技能載入次數"),
		meaning: t("How often agents opened a skill's instructions; a skill nobody loads is not shaping the work.", "代理人打開技能說明的次數；沒人載入的技能等於沒在影響工作。"),
		goodDirection: "none",
		howComputed: t("Reads of a skill's SKILL.md, /skill: commands, and skills a subagent role declares.", "讀取技能的 SKILL.md、/skill: 指令，以及子代理角色宣告的技能。"),
	},
	skill_sessions: {
		label: t("Sessions that loaded it", "載入過的工作階段數"),
		meaning: t("How widely a skill is used, not counting repeated loads in one session.", "技能用得多廣，同一工作階段重複載入只算一次。"),
		goodDirection: "none",
		howComputed: t("Sessions with at least one load of the skill.", "至少載入一次該技能的工作階段數。"),
	},
	never_loaded: {
		label: t("Offered but never loaded", "有提供但從未載入"),
		meaning: t("Skills pi lists to agents that no agent opened in the window; candidates to fix their description or remove.", "pi 有列給代理人、但期間內沒有代理人打開的技能；可考慮改寫說明或移除。"),
		goodDirection: "lower",
		howComputed: t("Skills in pi's skill list in the newest sessions, minus skills loaded in the window.", "最新工作階段裡 pi 提供的技能清單，扣掉期間內載入過的技能。"),
	},
	skill_cost: {
		label: t("Cost of sessions using the skill", "使用該技能的工作階段花費"),
		meaning: t("Money spent in sessions that loaded the skill; it shows where spend goes, not that the skill caused it.", "載入該技能的工作階段花了多少錢；顯示錢花在哪，不代表是技能造成的。"),
		goodDirection: "none",
		howComputed: t("Sum of each session's model cost, for every skill it loaded.", "每個工作階段的模型費用，加到它載入的每個技能上。"),
	},
	package_calls: {
		label: t("Calls by package", "各套件被呼叫次數"),
		meaning: t("Which installed packages the agents actually rely on.", "代理人實際依賴哪些已安裝的套件。"),
		goodDirection: "none",
		howComputed: t("Tool calls grouped by the package that registered the tool.", "依註冊該工具的套件分組的工具呼叫數。"),
	},
	ask_calls: {
		label: t("Questions to you", "問你的次數"),
		meaning: t("How often agents stopped to ask you something.", "代理人停下來問你問題的次數。"),
		goodDirection: "none",
		howComputed: t("Calls to the ask-user tools.", "呼叫詢問使用者工具的次數。"),
	},
	ask_wait_ms: {
		label: t("Average wait for your answer", "等你回答的平均時間"),
		meaning: t("How long agents sat idle waiting for you; long waits block the work.", "代理人閒著等你回答多久；等太久會卡住工作。"),
		goodDirection: "lower",
		howComputed: t("Mean time from the question appearing to the answer, for answered questions.", "從問題出現到收到回答的平均時間，只算有回答的。"),
	},
	ask_cancel_rate: {
		label: t("Questions dismissed", "被取消的提問比例"),
		meaning: t("How often you dismissed a question instead of answering; high can mean questions you did not need.", "你取消而非回答提問的頻率；偏高可能代表問了不必要的問題。"),
		goodDirection: "lower",
		howComputed: t("Cancelled questions divided by all questions.", "被取消的提問數除以全部提問數。"),
	},
	monitor_outcomes: {
		label: t("Background jobs by outcome", "背景工作結果分布"),
		meaning: t("How background commands (builds, tests, watchers) ended.", "背景指令（建置、測試、監看）最後怎麼結束。"),
		goodDirection: "none",
		howComputed: t("Finished monitors grouped by their final status; older sessions only kept about half of the endings.", "依最終狀態分組的已結束監看；較舊的工作階段大約只留下一半的結束紀錄。"),
	},
	monitor_duration_ms: {
		label: t("Average background job time", "背景工作平均時長"),
		meaning: t("How long background jobs ran.", "背景工作跑了多久。"),
		goodDirection: "none",
		howComputed: t("Mean time from start to finish where both are known.", "起訖時間都知道時，從開始到結束的平均時間。"),
	},
	subagent_launches: {
		label: t("Subagents launched", "啟動的子代理"),
		meaning: t("Which helper roles and models the agents hand work to.", "代理人把工作交給哪些輔助角色與模型。"),
		goodDirection: "none",
		howComputed: t("Successful subagent launches, grouped by the role and model asked for.", "成功啟動的子代理，依要求的角色與模型分組。"),
	},
	subagent_cost: {
		label: t("Subagent cost by role", "各角色子代理花費"),
		meaning: t("Where the helper agents' spend goes.", "輔助代理人的錢花在哪些角色上。"),
		goodDirection: "none",
		howComputed: t("Model cost of each subagent session, credited to the role its parent launched it with.", "每個子代理工作階段的模型費用，算在母工作階段啟動它時指定的角色上。"),
	},
	cost: {
		label: t("Model cost (USD)", "模型費用（美元）"),
		meaning: t("What the work cost, as reported by the model providers.", "這些工作花了多少錢，依模型供應商回報。"),
		goodDirection: "lower",
		howComputed: t("Sum of the cost recorded on every model reply.", "每則模型回覆記錄的費用加總。"),
	},
	cost_per_session: {
		label: t("Cost per session", "每個工作階段花費"),
		meaning: t("Average spend for one piece of agent work.", "一份代理人工作的平均花費。"),
		goodDirection: "lower",
		howComputed: t("Total model cost divided by sessions.", "模型費用總額除以工作階段數。"),
	},
	skill_loads_per_session: {
		label: t("Skill loads per session", "每個工作階段載入技能數"),
		meaning: t("How much skill instruction an average session reads.", "平均每個工作階段讀了多少技能說明。"),
		goodDirection: "none",
		howComputed: t("Skill loads divided by sessions.", "技能載入次數除以工作階段數。"),
	},
	notices_per_session: {
		label: t("Close-guard reminders per session", "每個工作階段收到的收尾提醒"),
		meaning: t("How often the close guard had to remind an agent to show its check passing.", "收尾檢查需要提醒代理人證明檢查通過的頻率。"),
		goodDirection: "lower",
		howComputed: t("Close-guard notices divided by sessions.", "收尾提醒次數除以工作階段數。"),
	},
	pass_rate: {
		label: t("Share that followed the rule", "遵守規則的比例"),
		meaning: t("Of the sessions where the rule applied, the share where the agent followed it.", "在規則適用的工作階段裡，代理人有遵守的比例。"),
		goodDirection: "higher",
		howComputed: t("Sessions that passed divided by sessions that passed or failed; sessions where it did not apply are left out.", "通過數除以（通過數＋未通過數）；不適用的工作階段不算。"),
	},
	agreement: {
		label: t("Your verdict matches the automatic check", "你的判斷與自動檢查一致"),
		meaning: t("How far the automatic check can be trusted: it is the share of sessions you labelled where you and it gave the same verdict.", "自動檢查有多可信：在你標記過的工作階段中，你和它判斷相同的比例。"),
		goodDirection: "higher",
		howComputed: t("Sessions where your label equals the check's label, divided by sessions you labelled for that check.", "你的標記與檢查結果相同的工作階段數，除以你為該檢查標記的工作階段數。"),
	},
	coverage: {
		label: t("Old sessions already indexed", "已建索引的舊工作階段"),
		meaning: t("Whether it is safe to clean up old session files: only indexed files keep their numbers after deletion.", "能否安全清理舊工作階段檔：只有建過索引的檔案在刪除後數字仍保留。"),
		goodDirection: "higher",
		howComputed: t("Session files inactive longer than the cut whose current size and time match the index, against all such files.", "閒置超過門檻、且目前大小與時間和索引相符的工作階段檔，對比所有這類檔案。"),
	},
	impact: {
		label: t("Before and after a change", "變更前後比較"),
		meaning: t("The same numbers in the days before and after one of your changes; a difference hints at an effect but does not prove it.", "你做某項變更前後幾天的同一組數字；有差異只是提示可能有影響，不能證明。"),
		goodDirection: "none",
		howComputed: t("Each number is computed over the days before the change and the days after, with how many sessions each side had.", "每個數字分別用變更前與變更後的天數計算，並附上兩邊各有幾個工作階段。"),
	},
	small_sample: {
		label: t("Too few sessions to read", "工作階段太少，不宜解讀"),
		meaning: t("One side had fewer than 20 sessions, so a difference may be chance.", "其中一邊少於 20 個工作階段，差異可能只是巧合。"),
		goodDirection: "none",
		howComputed: t("Flag set when either window has fewer than 20 sessions.", "任一邊少於 20 個工作階段時標記。"),
	},
	confounded: {
		label: t("Other changes nearby", "附近還有其他變更"),
		meaning: t("Other changes happened in the same days, so a difference cannot be credited to this one alone.", "同一段時間還有別的變更，差異不能只算在這一項。"),
		goodDirection: "none",
		howComputed: t("Count of other changes (not from the same commit) inside either window.", "兩邊期間內其他變更（不同提交）的數量。"),
	},
};

export const DETECTOR_META: Record<string, DetectorMeta> = {
	anchor_before_first_edit: {
		label: t("Said how to check before editing", "動手前先說好怎麼驗證"),
		meaning: t("The agent named the check that proves the work (its Anchor) before changing any file.", "代理人在改任何檔案前，先說出用什麼檢查證明工作完成（Anchor）。"),
		goodDirection: "higher",
		howComputed: t("Passes when an Anchor line or a todo anchor appears before the first successful edit or write; sessions without edits do not count.", "第一次成功修改或寫檔之前出現 Anchor 行或待辦的 anchor 即通過；沒改檔的工作階段不算。"),
		example: {
			pass: t("Writes 'Anchor: `npm test`', then edits src/app.ts.", "先寫「Anchor: `npm test`」，再修改 src/app.ts。"),
			fail: t("Edits src/app.ts first and names the check afterwards.", "先修改 src/app.ts，之後才說要怎麼檢查。"),
		},
	},
	check_after_last_edit: {
		label: t("Ran the check after the last edit", "最後一次修改後有跑檢查"),
		meaning: t("After its final change, the agent ran the check it named and the check passed.", "最後一次修改後，代理人有跑它說好的檢查，而且通過。"),
		goodDirection: "higher",
		howComputed: t("Passes when every command in the Anchor has a passing run after the last edit; sessions with no edit or no runnable Anchor do not count.", "Anchor 裡每個指令在最後一次修改後都有通過的執行即通過；沒改檔或 Anchor 不是可執行指令的不算。"),
		example: {
			pass: t("Edits a file, then runs `npm test`, which exits 0.", "改完檔案後執行 `npm test`，結束碼 0。"),
			fail: t("Runs `npm test`, edits one more file, and stops.", "跑完 `npm test` 又改了一個檔案就結束。"),
		},
	},
	todo_evidence: {
		label: t("Finished tasks carry proof", "完成的待辦附有證據"),
		meaning: t("Tasks marked done in the todo list record which check showed them done.", "待辦清單中標為完成的項目，有記錄是哪個檢查證明它完成。"),
		goodDirection: "higher",
		howComputed: t("Share of completed tasks in the final todo list that have evidence; passes only when all do. Sessions without completed tasks do not count.", "最終待辦清單中已完成項目附有證據的比例；全部都有才算通過。沒有完成項目的不算。"),
		example: {
			pass: t("Task 'Fix login' is completed with evidence 'npm test: pass'.", "「修好登入」完成，證據記錄「npm test: pass」。"),
			fail: t("Task 'Fix login' is completed with no evidence.", "「修好登入」標為完成，但沒有證據。"),
		},
	},
	close_guard_quiet: {
		label: t("Closed without a reminder", "收尾時不需要提醒"),
		meaning: t("The anchorloop close guard never had to remind the agent about a missing or failing check.", "anchorloop 收尾檢查從未需要提醒代理人缺少或未通過檢查。"),
		goodDirection: "higher",
		howComputed: t("Passes when a session that edited files got no close-guard notice; fails name the most frequent reminder.", "有改檔的工作階段沒收到任何收尾提醒即通過；未通過時記錄最常出現的提醒種類。"),
		example: {
			pass: t("Edits, runs the check green, ends; no reminder appears.", "改檔、跑檢查通過、結束，沒有出現提醒。"),
			fail: t("Edits and ends; the guard adds 'no passing run of `npm test`'.", "改檔就結束，收尾檢查加上「沒有 `npm test` 的通過紀錄」。"),
		},
	},
};

export const NOTICE_META: Record<string, Text> = {
	no_anchor: t("Files changed but no Anchor was stated", "改了檔案但沒說要怎麼驗證"),
	no_passing_run: t("No passing run of the Anchor after the last change", "最後修改後沒有通過的檢查"),
	evidence_handoff: t("Reminded to record a passing run as todo evidence", "提醒把通過的檢查記到待辦證據"),
	other: t("Other reminder", "其他提醒"),
};

export const CHANGE_KIND_META: Record<string, Text> = {
	pin: t("Package version", "套件版本"),
	"model-routing": t("Model routing", "模型分派"),
	rule: t("Rule or instructions", "規則或指示"),
	skill: t("Skill", "技能"),
	"agent-role": t("Agent role", "代理人角色"),
	manual: t("Your note", "手動標記"),
};
