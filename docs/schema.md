# Record schema, version 1

Live records (`events/<YYYY-MM-DD>.jsonl`) and back-filled records (`index/records/<YYYY-MM>/<key>.jsonl`) share one shape: one JSON object per line.
Names follow the [OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai) where they define one (status: Development); `pi.*` names pi facts, `anchorloop.*` names process facts, and `eval.*` names evaluation metadata that OTel does not define yet.
The envelope is shaped so a replay to an OTLP backend needs no renaming.

## Envelope

| Field | Type | Meaning |
| --- | --- | --- |
| `schema_version` | number | `1`. Additive changes keep the version; a removed or renamed field raises it. |
| `name` | string | Span or event name, from the table below. |
| `kind` | `"span"` \| `"event"` | A span has a duration; an event is a point in time. |
| `ts` | ISO 8601 UTC | Start of a span, or the time of an event. |
| `end_ts`, `duration_ms` | ISO, number | End and length of a span, when known. |
| `trace_id` | 32 hex | One trace per user prompt: everything from one prompt to the next. Stable across re-extraction. |
| `span_id` | 16 hex | Stable id derived from the session id and the entry or tool call id. |
| `source` | `"backfill"` \| `"live"` | Which reader wrote it. |
| `attrs` | object | Attributes. Strings must look like names (letters, digits, `_@./:+#=\|-`, at most 160 characters); anything else is stored as `redacted`. |

Every record carries `session.id` (the pi session id from the session header) and `pi.project` (a short project key: the repository name for `~/projects/<repo>/…` and for Herdr worktrees, else the first path segment).

## Records

| Name | Kind | Attributes |
| --- | --- | --- |
| `pi.session` | event | `pi.session.kind` (`interactive` \| `subagent`), `pi.subagent.logical_id`, `pi.session.parent_id`, `gen_ai.request.model` (last model), `pi.tool_calls`, `pi.usage.cost_usd`. Back-fill writes it when a session file ends (`ts` start, `end_ts` last entry); live writes it at session start. |
| `invoke_agent` | span | One per user prompt (the trace root). `gen_ai.operation.name` = `invoke_agent`, `gen_ai.agent.name` = `pi`, `pi.prompt.origin` (`user` \| `skill_command` \| `extension`), and in back-fill `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_write.input_tokens`, `pi.usage.cost_usd`, `pi.tool_calls` for the whole prompt. |
| `execute_tool` | span | One per finished tool call, including failed, blocked and aborted calls. `gen_ai.operation.name` = `execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `error.type` (`tool_error` when the result is an error), `pi.duration.source` (`measured` \| `timestamps` \| `not_run`), `pi.tool.exit_code` (bash). Live adds `pi.tool.owner` and `pi.tool.owner_version` from `pi.getAllTools()` sourceInfo, and `pi.tool.parent_call` for nested calls. A read of a skill file adds `gen_ai.skill.name` and, for files other than `SKILL.md`, `gen_ai.skill.resource.name` (the OTel agent-skills refinement applied to pi's `read`). Ask-user calls add `pi.ask_user.questions`, `pi.ask_user.cancelled`, `pi.ask_user.source` (`terminal` \| `remote` \| `none` live; `unknown` in back-fill). Subagent launches add `gen_ai.agent.name` (role), `gen_ai.request.model`, `pi.subagent.logical_id`. |
| `pi.skill.load` | event | `gen_ai.skill.name`, `pi.skill.trigger` (`read` \| `slash` \| `declared` \| `bash`), `gen_ai.tool.call.id` when a tool call loaded it. Count skill use from these records only; the skill attributes on `execute_tool` describe the same read. |
| `pi.monitor` | span | `pi.monitor.id` (per session), `pi.monitor.status` (`completed` \| `error` \| `stopped` \| …), `pi.monitor.exit_code`, `pi.monitor.output_lines`, `pi.monitor.reported_status` (live). Back-fill sees only the endings pi-loop-monitor delivered to the session (about half); live sees every `monitor:*` event. |
| `anchorloop.close_guard.notice` | event | `anchorloop.notice.kind`: `no_anchor`, `no_passing_run`, `evidence_handoff`, `other`. |
| `gen_ai.evaluation.result` | event | One per process detector per session. `gen_ai.evaluation.name`, `gen_ai.evaluation.score.label` (`pass` \| `fail` \| `na`), `gen_ai.evaluation.score.value` (1, 0, or a share), `gen_ai.evaluation.explanation` (a fixed reason code), `eval.annotator_kind` = `CODE`, `eval.scope` = `session`, `eval.detector.version`. |
| `pi.compaction` | event | A compaction entry in the session. |
| `pi.tools.snapshot` | event | Live, once per session at the first prompt: `pi.tools`, a sorted list of `tool=owner@version`. |
| `pi.skills.available` | event | Live, once per session: `pi.skills`, the names of the skills pi offered. |

### Process detectors

| `gen_ai.evaluation.name` | `pass` | `fail` explanations | `na` explanations |
| --- | --- | --- | --- |
| `anchor_before_first_edit` | `anchor_first` | `change_before_anchor`, `anchor_only_in_brief` | `no_edit` |
| `check_after_last_edit` | `anchor_green` | `no_passing_run_after_change` | `no_edit`, `no_anchor`, `anchor_without_command` |
| `todo_evidence` | `all_evidenced` | `completed_without_evidence` (value = share with evidence) | `no_completed_task` |
| `close_guard_quiet` | `no_notice` | the commonest notice kind | `no_edit` |

Sessions that started before 2026-11-23T10:51:07Z (the anchorloop 3.0.0 pin) get `na` with `out_of_scope_pre_3.0` for all four.

## Labels (for a later phase)

`labels.jsonl` in the state dir, one human verdict per line:

```json
{ "session_id": "01a2…", "evaluation_name": "anchor_before_first_edit", "label": "fail", "at": "2026-12-01T09:00:00Z", "note": "optional" }
```

The report joins these with `index/session-evals.json` (the code labels per session) and shows how often they agree.

## Change timeline

`changes.jsonl`, rebuilt by every extract, one change per line:

```json
{ "at": "2026-11-25T08:12:00.000Z", "kind": "pin", "subject": "commit subject", "package": "pi-anchorloop", "from": "3.2.0", "to": "3.3.0", "sha": "7614445…", "repo": "weihung-basic-agent", "source": "git" }
```

`kind` is `pin`, `model-routing`, `rule`, `skill`, `agent-role`, or `manual`; `source` is `git`, `live` (a version change between two live tool snapshots) or `mark` (`/evals mark`).
Unlike records, `subject` is free text: a commit subject or your own note.
