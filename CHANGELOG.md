# Changelog

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
