# Design

pi-evals 0.1.0 is phase 1 of an evals effort for one person's pi setup: record how skills and packages are used and whether the work follows the anchorloop process, from past sessions and from now on, and show it in a report.
This file records the decisions and the words they came from.
The evidence came from four research notes written before the build (in the maintainer's agent-root repository, `scratch/evals/`): `instrumentation.md` (which pi seams carry which facts), `inventory.md` (anchorloop, pi-session-doctor and the session format on disk), `literature.md` (papers, OSS and the OTel conventions), and `research.md` (vendor guidance on agent and skill evals).

## What the owner asked for

The request, 2026-11-25: 「我想要強化一下 ai evals（上網看看最佳實踐），這可以把 session doctor 移除，或是把 session doctor 升級成 evals 工具，包括可以從資料產出視圖」 (strengthen AI evals following best practice; remove pi-session-doctor or upgrade it into an evals tool, with views produced from the data).

Decisions on 2026-11-26, binding for this package:

| Words | Decision |
| --- | --- |
| 「新套件 pi-evals，移除 session doctor」 | A new package. pi-session-doctor profiles event-loop stalls and never reads transcripts (inventory §5), so nothing of it carries over; its removal happens in the setup repository, not here. |
| 「回頭抽取＋小觀察器」 | A read-only back-fill over the session files, plus a small live observer only for what those files lack. |
| 「自己產出靜態網頁」 | Our own static HTML report, not a hosted or self-hosted trace server. |
| 「可能會需要重新撰寫我們自己的 ask user … or monitor 如果他們沒有提供能記錄蹤跡的接口」 | No rewrite. The ask-user tool's results already hold the questions' count, cancel flag and wait time, and its `rpiv:ask-user:*` events show where an answer came from; pi-loop-monitor emits `monitor:started/finished/done/error` on `pi.events` with everything a record needs (instrumentation §2, §5). The observer listens; both packages stay untouched. |
| 「用 pi command 操作，這樣 agent 也可以自己去看」 | `/evals` (status, extract, report, mark) is the main surface, and one tool, `evals_query`, lets an agent read bounded summaries. The CLI is a thin wrapper over the same functions. |
| 「報表的設計會很重要，要注重人類可讀性，最好是可以記錄我做出的架構調整所造成的影響」 | A change timeline (pins, model routing, rules, skills, agent roles, live version changes, manual marks) with the same numbers before and after each change. The data (ReportModel, `model.json`) is separate from the renderer; this release ships a plain renderer, and the designed one will replace it after a mockup round. |
| 「先索引，穩定後再開清理」 | No cleanup code. `/evals status` and `evals_query coverage` report how many session files older than the cut (default 60 days without changes) the index fully covers, by count and bytes: the gate before a retention tool may delete them. Extra session roots (a future trash dir) are a setting. |
| 「我認為應該是 /eval 當下就可以做標記，也可以讓 agent 在做錯被糾正的時候標記，這樣才有辦法正確反映當下情境」 | `/evals label` records the user's verdict on a rule in the current session, and the `evals_label` tool lets the agent log a correction it was given; see [Labels in the moment](#labels-in-the-moment-050). |
| 「記得我對 evals 是門外漢，你的報表和標記網頁要讓我有辦法看懂」 | Every metric and detector in the ReportModel carries a label, one sentence of meaning, the better direction, one sentence on how it is computed, and for detectors a pass and a fail example, in English and Traditional Chinese. No unexplained statistics terms in what the reader sees. |

Later phases, not built here, each with a seam left open: with-and-without-skill A/B runs (phase 3), and session cleanup through a retention tool once the index covers old sessions (phase 4; `extraRoots` reads its trash dir).

## Decisions

### One record shape, OTel names

OpenTelemetry's GenAI conventions already name the facts asked for: `execute_tool` spans with an agent-skills refinement (`gen_ai.skill.name`, `gen_ai.skill.resource.name`), `invoke_agent`, usage tokens, and the `gen_ai.evaluation.result` event (literature §2).
pi-evals uses those names, `pi.*` for pi facts, `anchorloop.*` for process facts, and `eval.annotator_kind` / `eval.scope` from OpenInference's annotation model, since OTel has no evaluation scope yet.
The session is an attribute (`session.id`), not a span, as pi-otel argues; a trace is one user prompt (literature §2, §4).
Skill use is counted from tool calls and expansions, never from text mentions: cc-skill-usage measured a 212-fold overcount from grepping names (literature §2).
A shell command counts as a skill load only when the whole command prints one `SKILL.md`; on the real corpus a looser rule counted 6,560 "loads" that were mostly searches and edits of skill files, against 21 under the strict rule.

### Privacy by construction

Sessions hold customer and ticket content and secrets (inventory, Gotchas; research §6).
Records hold derived facts only, and the guard is in the record builder: every string attribute must look like a name or it becomes `redacted`.
The summary keys (tool, skill, model and role names) pass the same check, because a model can choose a tool name or a path freely.
The privacy test was written first and failed on exactly that: a secret placed in a read path and a tool name reached `days.json` and the report through the summary keys while the records stayed clean.

### Back-fill

The session files hold almost everything (instrumentation §5): tool calls with `durationMs` (from October on; older calls use the time between call and result), the ask-user results in both the current and the retired `pi-ask-user` shapes, the skill catalog pi offered (the system message's `skills` section), monitor endings delivered as `pi-loop-monitor` messages, and close-guard notices.
Extraction streams each file line by line on a pool of worker threads and writes one record file per session file atomically.
It is incremental by path, size and modification time, so a later extract reads only active sessions; an extractor version in the checkpoint forces a full re-read when extraction changes.
A subagent session is linked to its parent three ways: the parent's `subagent` result (`details.id`, the child's logical id), `~/.pi/agent/dispatch-ledger/<parent>.json`, and the artifacts path in the child's brief.
Live records and back-fill meet by session id: back-fill counts win, and live adds monitor lifecycles and answer sources.

### Live observer

It registers handlers and nothing heavy: one tool-owner snapshot per session from `pi.getAllTools()` sourceInfo, the nearest `package.json` for name and version (instrumentation §1: "do not infer ownership from names"), a record per `tool_execution_end` (which also fires for blocked, aborted and invalid calls), skill loads from reads, `/skill:` input and declared-skills messages, `monitor:*` events, and `rpiv:ask-user:answer` to tag remote answers.
It appends to the state dir, never to the session file, and a failed write warns once per session and is otherwise ignored.

### Process detectors

Four session-scoped checks, each a `gen_ai.evaluation.result` with `annotator_kind` CODE.
Anchor and change reading is ported from anchorloop's close guard (`pi/close-guard.ts` `read()`, 3.3.0), whose repository rules keep the guard small, so the evals live outside it (inventory §1).

- `anchor_before_first_edit`: an `Anchor:` line or todo anchor appears before the first successful `write` or `edit`. An anchor stated only in a subagent's brief is still a fail, named `anchor_only_in_brief`, so the report can tell the two apart.
- `check_after_last_edit`: every command of the anchor has a passing run after the last change.
- `todo_evidence`: completed tasks in the final todo list carry evidence; the value is the share that do.
- `close_guard_quiet`: an editing session got no close-guard reminder about a missing or failing check (an evidence hand-off reminder does not count).

Only sessions that started after anchorloop 3.0.0 reached this setup are judged: the pin commit in weihung-basic-agent, 2026-11-23T10:51:07Z. Older sessions are out of scope rather than failing (inventory, Gotchas), and they are left out of the "not applicable" counts.
Like the guard, an edit made through bash is not seen as a change.
These are process checks on observable events, which suits a process skill whose path is the product (research §1); they say how often the rules were followed, not whether the work was right.
A session's anchorloop version is the newest pin in the change timeline at or before the session's start, so a pin at 16:46 splits that day's sessions at 16:46.

### Change impact

Each change gets the same handful of numbers for the sessions that started in the 7 days (by default) before the change's time and in the 7 days from it, with the session count on each side.
The split is by start time, not calendar day: an earlier version split by day and credited a pin's effect to the 588 sessions of that day that ran before the pin.
Three flags go with each comparison: a side with fewer than 20 sessions is too small to read; a window that reaches before the first session or past the last extract is incomplete, with the days that have data on each side; and other commits inside the windows are counted once each, by the kinds they changed.
The flags are shown, not hidden: these comparisons hint at an effect and prove none (research §1 on noise: single runs vary by several points).
With this setup's pace of change almost every comparison has other commits nearby, so the kinds matter more than the count.

### Report

The ReportModel holds every number with its n and window, and the plain-language metadata; the renderer reads only it.
The HTML has no scripts, no network and no external assets, uses inline SVG, and follows the system's light or dark setting.
It renders in Traditional Chinese by default (`--lang en` for English).

Version 0.2.0 uses the timeline and comparison layouts selected on 2026-11-26.
The renderer makes the following editorial choices from the model, without consulting transcripts or fetching data:

- A pin or routing change qualifies for the front page even without a comparison; another change qualifies only if both windows have at least 20 sessions.
- The headline gives priority to a change to the process rules themselves: an anchorloop pin within seven days of the latest change with at least 20 applicable sessions on both sides of the anchor check. Otherwise take the newest qualifying comparison with enough sessions, then the newest qualifying change. With no candidate, report why there is nothing to compare.
- Show the lead and at most one earlier change from a different commit. Prefer a small sample with records on both sides (to show why the numbers might mislead), then a pin or routing change with a complete window, then the next eligible change. Order the cards by time. Keep every other entry in its UTC day’s disclosure, with a direct link to its detail; no truncation.
- For an anchorloop pin with two comparable readings of the anchor check, compare the two process rates. Otherwise use the package error rate when available on both sides, or the overall tool error rate, alongside cost per session. Rates use their own denominators, not the total session count. A missing value is a dash, not zero.
- The headline names the first comparable reading and whether it rose, fell or held steady at the displayed precision. A short window, small sample or overlapping change qualifies that observation. The verdict lists every applicable caveat, including a displayed reading based on fewer than 20 applicable observations on either side. Only a complete, unconfounded comparison with enough observations and a visible difference says there was an observable change. Even that is not a causal claim.
- The workload chart covers the last seven complete UTC dates in the report period (or fewer if the filter starts later), not seven nonempty days. Each marker means at least one change that day. Session and tool totals in the other sections still cover the selected report period.
- Each detail uses the model’s actual window and session counts. Dates with records may exceed seven in a seven-day window that starts mid-day. The ruler shows the last extract only when it falls inside the after window, and its segments are not to scale.

### Date ranges and findings (0.3.0)

The 30-day page opens first; the other pages cover 14 days, 90 days or all indexed dates.
The last day is the UTC date of extraction, even when the extract is old, so a stale index does not become an apparently quiet month.
The chart now covers the selected period including the partial last day.
The report reads the index and checks file coverage once, then reuses the same change comparisons in each narrower period.
The set of currently offered skills is the reference list; “never loaded” means no loads in the selected dates and project, not that the skill has never been used.
Coverage counts files modified in the chosen dates and separately shows the cleanup gate across all dates and projects.

`findings` uses the timeline’s headline, trust line, selection and verdicts, without copying the text of a commit or manual note.
For error trends it compares the two seven-day periods immediately before the extraction date, excluding the partial day, only if both weeks fit inside the selection and the index extends to the first date.
It counts tool errors over calls per package and job endings marked `error` over all recorded endings; both weeks need at least 20 observations and a rise of at least five percentage points.
If several packages qualify, the largest rise wins, then the larger recent call count, then the package name.
No flag means no rise met that rule, not proof that nothing went wrong.

### Labels in the moment (0.5.0)

The first 20 labelled sessions were judged after the fact from AI summaries, and the code agreed on 10 of 20 and 4 of 11.
A summary can leave out what decided the verdict, so the gap cannot be put on the code or on the summary.
A label given while the work is in front of the user does not have that problem, so the report keeps the two apart and shows agreement for each.

`/evals label` asks three plain questions (which rule, followed or not, an optional note) and needs no arguments; the one-line form is for speed.
A label is tied to the session and the todo item in progress, keyed as back-filled work items are, so it can later join the item.
`undo` appends a withdrawal instead of rewriting the file, so a label another session appends at the same moment cannot be lost.
`/evals label <your words>` (「/evals label 後面應該允許接 prompt。要求 agent 根據格式標注」) sends the words to the agent, which formats them into rows; the command, not the agent, supplies the note, and the right to write a human row (`on_behalf: "user"`) opens when that turn starts and closes at its end.

The agent's `evals_label` takes enumerated names and nothing else, and its tool text stays near 690 bytes, since every session pays for it.
Its rows never enter the agreement: an agent's own account of being corrected is not a verdict on the code.
They are counted as 「被糾正」 by rule, failure type, the skills loaded before the correction, and the anchorloop version at the time.
The count covers corrections that were logged, not every mistake; with fewer than 20, the report says it is too few to show a trend.
A label whose session is not extracted yet enters a date or project filter by its own time and project, so it shows up at once.

### Storage choices

JSON lines and JSON files, no database: the index is rebuilt from per-session summaries in about a second, and the reader needs no service (research §4: everything reduces to files plus one static page).
Back-filled records take about 0.7 GB for the 23.8 GB corpus; the per-day aggregates the report and the tool read take about 1.5 MB.

## Measured on the maintainer's corpus (2026-11-26)

- 21,526 session files, 23.8 GB, read in 21 to 84 seconds with seven workers (285 to 1,130 MB/s over four runs, depending on the disk cache and machine load), peak memory 3.0 to 3.2 GB; with one worker, 129 seconds (185 MB/s) and 1.0 GB. `--workers` caps both. A later extract reads only the files that changed: 23 files in under 2 seconds.
- 1.40 million records: 1.14 million tool calls, 80,000 detector results, 29,000 prompts, 11,000 skill loads, 7,300 monitor endings.
- Cross-checks against the raw files: ask-user calls 5,101 by both counts; `SKILL.md` reads on 2026-11-24, 570 raw against 568 counted (the two missing reads failed); one session's 73 tool calls, 73 in its summary and 73 records.
- Sixty random text samples from transcripts (messages, thinking, tool arguments) appear in no file under the state dir.
