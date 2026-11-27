# Changelog

## 0.10.1

- A built fixture turns off git's background gc and maintenance (`gc.auto=0`, `maintenance.auto=false`). A first `exp check` on a large repo could fail copying the fixture while an auto gc pruned loose objects under `.git/objects`.

## 0.10.0

- Per-trial artifacts: the check gets `EXP_ARTIFACT_DIR` (the trial's `artifacts/`). A task with `"screenshot": {"script", "timeout_s"}` runs that script from `check/` after the check; `artifacts/shot.png` and `screenshot: {ok, sha256, ms, exit}` are recorded in `grade.json`. The screenshot never changes the outcome.
- `exp check` gates screenshot tasks: the base and reference are shot twice each, the reference must be stable (same sha256, or ≤ 0.1% of pixels by the task's `compare.sh`) and differ from the base (≥ 0.5% of pixels, or by sha256). The shots are kept under `fixtures/gate-shots/<task>/`. `--ref-runs N` sets how many reference check runs the gate makes (default 3).
- `exp label <run> --ui` writes a blind review page of every trial's screenshot next to the issue, the base and the reference, under random file names in a seeded order; `--ui --answer` stores the picks as `ui_outcome` labels. `exp show` reports screenshots produced and the share judged right per arm, B − A with its CI, and agreement with the verifier.

## 0.9.0

- `pi-evals exp` can test a main agent that dispatches work. A suite with a `dispatch` block in `suite.json` (a vendored pi-herdr-agents checkout, `maxConcurrent`, `maxLaunches`) runs each trial's main as `pi --mode rpc`, with pi-herdr-agents' `subagent` and the suite's model as its only model. The runner waits while children are out, then sends the follow-up once. Children run in a Herdr server private to the run, one workspace per trial, and load the same arm as the main from the trial's agent dir (`settings.json`, `APPEND_SYSTEM.md`, `herdr-agents/config.json`). Suites without `dispatch` run as before.
- A small extension loaded into every session of a dispatch trial enforces the child limits (no worktrees, no persistent children, no cwd outside the work dir) and records which skills and system prompt each session loaded. A child whose arm differs from its main's makes the trial invalid (`arm_mismatch`). A leak or quota refusal in a child's transcript counts as one in the main's.
- Dispatch trials record `children`, `childEfficiency`, `totalEfficiency` and `dispatch` (launches, results, blocked launches, most children at once, time waited, processes left over). `exp show` reports cost and agent-minutes including children, and children per trial. When a trial ends or times out, its workspace is closed and its leftover processes are killed.
- The trial's own session is now read from the top of its session dir, so child artifacts below it are never taken for it.

## 0.8.1

- `exp check` lets a reference check run as long as the task's `check_timeout_s` (default limit stays 180 s), so tasks with slow verifiers, such as SWE-Bench Pro's Go and JS suites in Docker, can pass the gate.

## 0.8.0

- New CLI command `pi-evals exp` runs controlled, paired experiments: the same tasks under two arms (for example without and with anchorloop) with the same model, so a difference can be put down to the arm. `exp check` confirms a task's base fails its check and its reference passes it 3 of 3; `exp run` runs k trials per task and arm, each with one identical follow-up turn; `exp grade` regrades stored trials after a grader fix; `exp show` gives pass@1, pass^k, process rates, cost and minutes per trial, and B − A with a paired cluster-bootstrap 95% CI over tasks.
- `exp run --tasks` reruns chosen tasks inside an existing run; the replaced trials are kept, marked superseded.
- `exp label` writes a blind form page of the trials where the arms disagree; `--answer` stores your verdicts in `labels.jsonl` with `source: "experiment"`, and `exp show` compares them with the graders. The monitoring report leaves these labels out.
- Answers are graded on every turn's reply, and leaks are read only from paths the trial touched.

## 0.7.0

- The analysis scripts from labelling and error analysis ship in `scripts/`: `freshness` (is the index current; exits 1 when summaries come from mixed extractor versions), `disagree <rule>` (where the code and your labels disagree, session by session, and which way), `by-version <detector>` (pass rate per package version), `sample <n>` (a stratified, seeded sample of unlabelled sessions to label), `label-import <answers>` (a submitted label form into `labels.jsonl`), and `session-shape <id>` (the ordered events the detectors see, without message text). Output over 2,000 bytes goes to a file under `runs/` in the state dir.
- `/evals run` lists the scripts with what each is for; `/evals run <script> [args]` runs one and shows its output, with script names completed.
- The analyzing-evals skill names these scripts at the steps that use them: freshness first, disagree and session-shape when a number looks wrong, sample and label-import for hand labels.

## 0.6.1

- An extract stopped part-way after an extractor upgrade no longer passes off old results as current. Each session file's summary now records the extractor version that wrote it, and any other version is read again. Before, the first 0.6.0 extract was killed by a timeout and saved the new version mark while most summaries were still old, so the next run skipped them: check agreement read 11/20 instead of 23/24 until a full rebuild. Every session is read once more (extractor version 6).
- New check 「排工作時說清楚怎麼分工」 (`plan_names_graph`): whether a Straw Boss coordinator or standing main names its plan's graph (`single-loop`, `fan-out/fan-in`, `orchestrator-worker`; the todo's `graph` field or an older `metadata.graph`) when it first creates open todos. It also passes when the next todo call adds the graph after sb's planning reminder (sb 0.101.0 and later). It fails when the main keeps planning without one. Unlike the anchorloop checks, it is judged in sessions of any age, since sb mains live for weeks.
- The process view and report also split this check by pi-straw-boss version at session start, before and from 0.101.0. The change strip always highlights the sb pin that brings 0.101.0, including one that skips it (0.100.2 → 0.102.0, captioned 「含 0.101.0」).
- The analyzing-evals skill gains 「When a number looks wrong」: check freshness first, validate a detector against your labels, group misses by cause, keep a guard set, and treat hand labels as the reference.

## 0.6.0

- New command `/ask-ai <question>` has the agent answer you now instead of taking the question as a reproach and starting new work. The question goes in with a short instruction: answer first, in your language, change nothing, start no work, and end with at most one line of suggested next step. While that run lasts (until it ends or you send another message), `write`, `edit`, `subagent`, `boss_pair`, `MonitorCreate`, `LoopCreate`, `call_tower`, `todo` (except `list`/`get`) and `intercom` (`send`/`ask`/`handover`) are refused with a one-line reason; `bash`, `read` and other tools still run.
- Each ask is recorded in `asks.jsonl` (session, time, project, todo item; never the question or the answer). The report's 「你的標記」 section and the `labels` query view say how many times you asked and how many you followed with a label in the same session within 30 minutes.

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
