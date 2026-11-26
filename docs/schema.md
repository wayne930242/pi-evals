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
| `attrs` | object | Attributes. Strings must look like names (letters, digits, `_@./:+#=\|-`, at most 160 characters); anything else is stored as `redacted`. The one exception is `pi.item.title`: a todo subject, cut to one line of at most 80 characters. |

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
| `pi.workitem` | span | One per todo task (written to `index/workitems.jsonl` on every build). `ts` = the first switch to `in_progress` (else creation), `end_ts` = completed or deleted, `duration_ms` = time in progress. `pi.item.key` (todo `uid`, else `<origin session>#<id>` for an import, else `<session id>#<id>`, with `.2`, `.3` when a `clear` reuses an id and `@<entry8>` for a task only on an abandoned `/tree` branch), `pi.item.title`, `pi.item.owner`, `pi.item.level` (`top` \| `nested` for a subagent's own list), `pi.item.status`, `pi.item.created`, `pi.item.close_kind` (`review_done` \| `landed` \| `wrap` \| `evidence` \| `unproven` \| `deleted` \| `open`), `pi.item.thread` (`T<n>`), `pi.item.evidence_n`, `pi.item.blocked_by_n`, `pi.usage.cost_usd` (main cost in the window, each reply split evenly among the items in progress at that moment), `pi.item.child_cost_usd` (exact cost of the joined subagent sessions), `pi.item.children` (their names), `pi.item.lines_changed` (git, from the previous item's last evidence commit in the same repository), `pi.item.sessions` (when a uid or import carried it across sessions). A `nested` item's cost is part of its subagent session, which the parent item already counts in `pi.item.child_cost_usd`: summing across levels counts it twice. A task first seen already completed or deleted (carried in by a list switch or an import) gets no record in that session. |
| `pi.stall` | span | A main idle of two minutes or more inside an item's window. `pi.item.key`, `pi.stall.kind` by what woke the main (`human` \| `peer` \| `child` \| `timer` \| `ci` \| `device`), `pi.stall.on` (a subagent name, a peer session's first 13 characters, or from the sb ledger `W<n>`, `L<n>`, `T<n>`), `pi.stall.via` (`idle` \| `ask` for a question tool held open). `duration_ms` is the part inside the item's window. |

### Work items

Back-fill rebuilds each session's items from its `todo/v1` snapshots, diffed along the entry tree. When producers add them, it reads todo `uid`, `origin.session` and evidence `ref` (`child:<id>` joins a subagent), `subagent` `details.item`, `boss_pair` `item`, the sb thread fields `item` and `closed`, and the sb ledger (`~/.pi/agent/straw-boss/ledger/*.jsonl`); without them it joins by names: a subagent whose name is the task owner, a reviewer `<prefix>-review*`, the sb thread whose worker is the owner, and a car whose coordinator is the session (ticket ids in the title must match). Close kind takes the first that holds: the linked thread's `done` within five minutes of the close, a car landed in the window, a successful `boss_wrap` around the close, evidence rows, else `unproven`.

### Process detectors

| `gen_ai.evaluation.name` | `pass` | `fail` explanations | `na` explanations |
| --- | --- | --- | --- |
| `anchor_before_first_edit` | `anchor_first` | `change_before_anchor`, `anchor_only_in_brief` | `no_edit` |
| `check_after_last_edit` | `anchor_green` | `no_passing_run_after_change` | `no_edit`, `no_anchor`, `anchor_without_command` |
| `todo_evidence` | `all_evidenced` | `completed_without_evidence` (value = share with evidence) | `no_completed_task` |
| `close_guard_quiet` | `no_notice` | the commonest notice kind | `no_edit` |

Sessions that started before 2026-11-23T10:51:07Z (the anchorloop 3.0.0 pin) get `na` with `out_of_scope_pre_3.0` for all four.

## Labels

`labels.jsonl` in the state dir is appended to, one row per line, and read at every report and query, with no extract needed.
There are three kinds of rows:

```json
{ "session_id": "01a2…", "evaluation_name": "anchor_before_first_edit", "label": "fail", "at": "2026-11-26T05:51:51Z", "annotator": "human" }
{ "session_id": "01a2…", "evaluation_name": "check_after_last_edit", "label": "fail", "at": "2026-11-26T06:00:00Z", "annotator": "human", "source": "live", "item": "MP-1234", "project": "demo-repo", "note": "optional, the user's own words" }
{ "session_id": "01a2…", "evaluation_name": "other", "label": "fail", "at": "2026-11-26T06:10:00Z", "annotator": "agent", "source": "correction", "type": "ignored_instruction", "item": "01a2…#3", "project": "demo-repo", "skills": ["coding"] }
```

- A row without `source` is a human verdict given after the fact (the report calls it 事後標, the code `batch`).
- `source: "live"` is a human verdict given in the moment with `/evals label`. `/evals label undo` appends `{ …, "source": "live", "undo": "<at of the withdrawn row>" }`, which withdraws the session's latest live row still in effect.
- `source: "correction"` is an agent's `evals_label` call: `label` is always `fail`, and `type` is one of `no_check_stated`, `no_check_run`, `skipped_rule`, `wrong_order`, `unverified_claim`, `ignored_instruction`, `other`. The tool accepts no other field or value.

`evaluation_name` is a process check name or `other`.
`label` is `pass`, `fail`, or `unclear` (the reader could not tell).
`item` is the key of the todo item in progress when the label was given: its `uid`, else `<origin session>#<id>` for a task carried over from another session, else `<session>#<id>`.
`note` is the only free text and is never shown in the report or a query result.

The report joins human rows with `index/session-evals.json` (the code labels per session) and shows how often they agree, by when the labels were given.
`unclear` labels are left out of the agreement rate and counted on their own (「看不出來 N」); labels on `other`, or on a session the code has not judged, are counted apart.
Agent rows never enter the agreement; they make the 「被糾正」 section.
With a date or project filter, a row belongs to the range by its session's start when the session is indexed, and by its own `at` and `project` otherwise.

## Change timeline

`changes.jsonl`, rebuilt by every extract, one change per line:

```json
{ "at": "2026-11-25T08:12:00.000Z", "kind": "pin", "subject": "commit subject", "package": "pi-anchorloop", "from": "3.2.0", "to": "3.3.0", "sha": "7614445…", "repo": "weihung-basic-agent", "source": "git" }
```

`kind` is `pin`, `model-routing`, `rule`, `skill`, `agent-role`, or `manual`; `source` is `git`, `live` (a version change between two live tool snapshots) or `mark` (`/evals mark`).
Unlike records, `subject` is free text: a commit subject or your own note.
