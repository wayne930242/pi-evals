# Changelog

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
