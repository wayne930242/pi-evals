# Changelog

## 0.5.2

- A later human label on the same session, rule and item replaces the earlier one in the report and agreement; `labels.jsonl` keeps both. New `source: "recheck"` for your second look at a label given after the fact (counted as 事後標). Each 「其他」 label stays its own event, and agent corrections are never replaced.

## 0.5.1

- The two anchor checks read the forms agents actually use, checked against 30 sessions you labelled by hand. An anchor counts when the agent or its brief names the check before the first edit: an `Anchor:` line, a `Gates:`, `Checks:`, `Verify:`, `Done when` or `驗證：` line, a todo anchor or sb check spec, or a check command named in the brief. It also counts when the first change is a test file (red first). A brief's anchor is no longer failed as `anchor_only_in_brief`.
- 「最後一次修改後有跑檢查」 passes on any of these: anchor commands run in a monitor (judged by exit code), passing todo evidence recorded after the last change, or a test, build, lint or type-check run after it. A failing anchor run still fails. Markdown or text written after the check (a report, a changelog) does not undo the check. A session that edits and runs no check now fails (`no_check_after_change`) instead of being left out. A session that edits only prose is `prose_only`.
- Agreement with your labels: anchor 15/30 → 24/30, check 4/17 → 23/24. Five held-out sessions that edited and ran no check stay failed on both rules.
- Re-extracts every session once (extractor version 5).

## 0.5.0

- `/evals label` labels the current session while the work is in front of you: pick a rule (or 「其他」), then 照做, 沒照做 or 看不出來, then an optional note. `/evals label <rule> pass|fail|unclear [note]` does it in one line, and `/evals label undo` withdraws the session's last one. `/evals label <your words>` hands your words to the agent, which turns them into labels and says what it recorded; the verdict and the note stay yours. Each label keeps the todo item in progress.
- A new tool, `evals_label`, lets an agent log a correction when you correct how it worked, by rule and failure type (`no_check_stated`, `no_check_run`, `skipped_rule`, `wrong_order`, `unverified_claim`, `ignored_instruction`, `other`). It accepts names only and adds about 690 bytes of tool text. It can write your label on your behalf only during a turn that `/evals label <your words>` started.
- The report's labels section counts labels given after the fact (事後標) and in the moment (當下標) apart, with code agreement for each; agent corrections never count toward agreement. A new 「被糾正」 section counts corrections by rule, failure type, skill loaded and anchorloop version, and says when there are too few to read. A concept card, 「當下標記 vs 事後標記」, explains the difference with this report's numbers.
- `evals_query` has a `labels` view, and `findings` adds a line when three or more corrections share a rule and failure type.
- Labels show up at the next report or query, with no extract needed.

## 0.4.1

- Work comparisons in `items`, `findings`, and the HTML report now give separate costs per item and per 100 changed lines, with the number of items behind each comparison. When the measures disagree, the report explains why neither group is necessarily cheaper overall.

## 0.4.0

- The report has a 「工作」 section: every todo item with its cost (subagents exact, main agent split evenly among items in progress at the same time), minutes in progress, how it closed (reviewer approval, a landed car, a wrap, evidence) and where it stalled, by what woke the main agent. A comparison of like with like says whether one model, role or anchorloop version costs less per item and per 100 changed lines, or that there are too few items to tell. Open items show where they stopped, on whom they wait, and for how long. Two concept cards explain cost attribution and fair comparison with this report's numbers.
- Back-fill rebuilds work items from `todo/v1` snapshots, never merging tasks across a `clear` or a `/tree` branch, and writes `pi.workitem` and `pi.stall` records. It reads todo `uid`, `origin` and evidence `ref`, the review thread's `item` and `closed`, and the sb ledger when they exist, and joins by names otherwise.
- A work item's title (its todo subject, at most 80 characters) is the only source text pi-evals stores.
- `evals_query` has an `items` view, and `findings` adds a line when a like-with-like difference or a long wait stands out.
- A label of `unclear` is left out of the agreement rate and counted on its own (「看不出來」).
- Re-extracts every session once (extractor version 4).

## 0.3.0

- Open the report on the last 30 days and switch to 14 days, 90 days or all time without scripts. For other dates use `--since` or `--days`.
- Ask `/evals findings` or use the `findings` tool view for the headline, its limits, and which numbers to read next. Tool views now default to 30 days.
- The `analyzing-evals` skill includes three small queries for the details of a change, daily sessions using one skill, and a package’s daily errors.

## 0.2.0

- The report opens on two architecture changes, with a workload chart and a comparison you can open for every entry in the timeline. Each comparison shows what was counted and what limits the conclusion.
- Five short explanations and two self-check questions introduce the numbers in the report; see [the worked example](docs/learn.zh-TW.md).
- `/evals extract` uses two workers by default to leave memory for pi. Pass `--workers N` to override; the standalone CLI retains its CPU-based default.
- Use npm’s canonical bin path so the packed CLI installs as `pi-evals` without a publish correction.

## 0.1.0

First release.

- One record shape with OpenTelemetry GenAI names (`execute_tool`, `invoke_agent`, `gen_ai.skill.name`, `gen_ai.evaluation.result`) plus `pi.*`, `anchorloop.*` and `eval.*`; strings must look like names or are stored as `redacted` ([docs/schema.md](docs/schema.md)).
- Back-fill of past sessions (`/evals extract`, `pi-evals extract`): streaming, worker threads, incremental by size and modification time, extra roots, subagents linked to their parents.
- Live observer: tool owners and versions, every finished tool call, skill loads, monitor lifecycles, ask-user answer source.
- Four anchorloop process checks per session from 2026-11-23 on.
- Change timeline from setup repositories' git history, live version changes and `/evals mark`, with before-and-after numbers per change.
- Index coverage of old session files, the gate for a later cleanup.
- ReportModel (`model.json`) with plain-language metadata in English and Traditional Chinese, and a plain static HTML report.
- `evals_query` tool: bounded summaries for agents.
