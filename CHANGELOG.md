# Changelog

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
