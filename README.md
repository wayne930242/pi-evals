# pi-evals

Records of how [pi](https://github.com/earendil-works/pi) agents use skills, packages, ask-user, monitors and subagents, and whether their work follows the anchorloop process rules.
It reads past session files once, keeps a small observer running for what those files do not hold, and builds a static HTML report.
Agents can read the same numbers through one tool, `evals_query`, and log a correction you gave them with another, `evals_label`.

## What it records

- **Skills**: loads per day and per project, how each was loaded (a read of its `SKILL.md`, a `/skill:` command, a subagent role's declared skills, a shell `cat` of the file), and the skills pi offers that no agent loaded.
- **Packages**: tool calls, errors and run time grouped by the package that registered each tool.
- **Ask-user**: questions asked, how long you took to answer, how many you dismissed, and whether the answer came from the terminal or a remote channel.
- **Monitors**: background jobs by outcome and duration.
- **Subagents**: launches by role and model, and their cost by role.
- **Process**: four checks of the anchorloop rules per session, and one of the Straw Boss planning rule (a coordinator or standing main names its plan's graph), for sessions started after anchorloop 3.0.0 was pinned (2026-11-23T10:51:07Z); see [docs/design.md](docs/design.md#process-detectors).
- **Cost**: model cost and tokens, and the cost of the sessions that loaded each skill.
- **Work items**: each todo task from the moment it is switched to in progress until it is done or deleted: what it cost (subagents exactly, the main agent as an even share), where it closed (reviewer approval, a landed car, a wrap, evidence), where it stalled and on whom, and whether one way of working is cheaper than another of the same kind.
- **Your labels and corrections**: your verdict on a process rule, given in the moment with `/evals label` or after the fact, and the corrections an agent logs when you correct how it worked.
- **Your changes**: package pins, model routing, rules, skills and agent roles from the git history of your setup repositories, version changes seen live, and notes you add with `/evals mark`, each with the same numbers in the days before and after.

## Privacy

Records hold derived facts only: names (tools, skills, packages, models, roles, project keys), counts, durations, exit codes, outcomes, and token and cost numbers.
They never hold transcript text, tool arguments, file contents, commands, questions, or answers.
Every string written to a record must look like a name (no spaces, no line breaks, at most 160 characters), or it is stored as `redacted`.
There are two exceptions: a work item's title (its todo subject, cut to one line of at most 80 characters), and the note you add to your own label with `/evals label` (one line, at most 500 characters, never shown in the report or a query result).
An agent's correction holds names only: the tool refuses any other text.
A test plants a secret in every text field of a session and checks that it reaches no output file and no query result outside a title field.

Everything stays on your machine, under `$XDG_STATE_HOME/pi-evals` (default `~/.local/state/pi-evals`).
Session files are only read, never written.

## Install

```sh
pi install npm:pi-evals
```

Then run `/reload` or restart pi.
The observer loads in every session, subagents included.

## Commands

| Command | What it does |
| --- | --- |
| `/evals` or `/evals status` | Record counts, the last extract, index coverage of old sessions, and the report path. |
| `/evals extract [--workers N]` | Back-fills changed sessions in a background process, with two workers by default to leave memory for pi. Progress shows in the footer. |
| `/evals findings [--since YYYY-MM-DD] [--project <key>]` | Shows the report’s headline, what limits it, and where to look next. |
| `/evals report [--since YYYY-MM-DD \| --days N] [--project <key>]` | Builds the linked date ranges, or one custom report when a start date or day count is given. |
| `/evals mark <note>` | Adds a note to the change timeline, e.g. `/evals mark workers moved to gpt-6.2-astra`. |
| `/evals label` | Labels the current session while the work is in front of you: pick a rule (or 「其他」), then 照做, 沒照做 or 看不出來, then an optional note in your own words. |
| `/evals label <rule> pass\|fail\|unclear [note]` | The same in one line; `<rule>` is a check name (`anchor_before_first_edit`, `check_after_last_edit`, `todo_evidence`, `close_guard_quiet`, `plan_names_graph`) or `other`. |
| `/evals label <your words>` | Anything else, e.g. `/evals label 剛剛沒先跑測試就說完成`: the agent turns your words into labels with `evals_label` and says in one line what it recorded. The verdict is yours and your words are kept as the note. |
| `/evals label undo` | Withdraws the current session's last label given in the moment. |
| `/evals run` | Lists the shipped analysis scripts, each with what it is for. |
| `/evals run <script> [args]` | Runs one and shows its output; output over 2,000 bytes goes to a file under `runs/` in the state dir and the reply names it. |

A label records the session, the time, and the key of the todo item in progress, if any (its `uid`, else `<session>#<id>`, as work items are keyed).
It reaches the report and `evals_query` at their next read, without an extract.

### Analysis scripts

Shipped in `scripts/`; run them with `/evals run`, or with `node <package>/scripts/<name>.mjs` (agents do, through the analyzing-evals skill). They read the index, checkpoint, labels and change timeline, never a transcript into their output; `session-shape` reads one session file to classify its events and prints no message text.

| Script | What it answers |
| --- | --- |
| `freshness` | Is the index current: last extract, summaries per extractor version, a run stopped part-way. Exits 1 when versions are mixed. |
| `disagree <rule> [--range DAYS]` | Each labelled session where the code and your verdict in effect disagree, with the code's reason and where the label came from, and which way they lean. |
| `by-version <detector> [--pkg PACKAGE]` | Pass rate and n per package version at session start (anchorloop by default; pi-straw-boss for `plan_names_graph`). |
| `sample <n> [--since ISO] [--seed N]` | A seeded sample of judged sessions you have not labelled, spread over project, kind, model and size, written to `labels/sample-<date>.json` (ids and metadata only). |
| `label-import <answer-file> [--sample FILE]` | Your submitted label form (`- <n>_<rule>: pass`, `- <n>_type: …`, `- <n>_note: …`) as after-the-fact labels in `labels.jsonl`. |
| `session-shape <session id>` | The events the detectors see, in order: tools, edit paths, check runs by exit code, todo statuses and evidence, close-guard reminders, the sb role; then each detector's verdict. |
| `change-impact`, `skill-days`, `package-errors` | A change's numbers before and after; a skill's sessions per day; a package's errors per day. |

### `/ask-ai`: get an answer before the agent acts

| Command | What it does |
| --- | --- |
| `/ask-ai <your question>` | Has the agent answer your question now, e.g. `/ask-ai 你剛剛有照並行設計流程嗎？`. With no question it shows the usage. |

Sometimes an agent hears a question as a reproach and starts re-planning, so the moment to label how it worked passes.
`/ask-ai` sends your question with a short instruction: answer first, in your language; read only what the answer needs; change nothing, start no work and dispatch nothing; if the question is about how it worked, say what happened and whether that followed the rule; end with at most one line of suggested next step, and wait.
If the agent is working, the question goes in after its current tool calls.

Until that run ends, or you send another message, these tools are refused with a one-line reason telling the agent to answer first: `write`, `edit`, `subagent`, `boss_pair`, `MonitorCreate`, `LoopCreate`, `call_tower`, `todo` (except `list` and `get`), and `intercom` (`send`, `ask` and `handover`).
`bash`, `read` and every other tool still run, so the agent can look things up.
Only you can type the command; agents cannot call it.

pi-evals records only that you asked (session, time, project and the todo item in progress), never the question or the answer.
The report's 「你的標記」 section says how many times you asked and how many of those you followed with a label in the same session within 30 minutes.

The same operations run from a shell, where extraction defaults to one fewer worker than available CPUs (at least one, at most eight).
On either surface, `--workers 0` reads the files sequentially without worker threads:

```sh
pi-evals extract [--root <dir>]... [--workers <n>] [--json]
pi-evals report [--out <dir>] [--since YYYY-MM-DD | --days N] [--project <key>] [--lang zh|en]
pi-evals status
pi-evals query <view> [--since YYYY-MM-DD] [--project <key>]
pi-evals mark <note>
```

### Experiments: `pi-evals exp`

Monitoring watches real sessions, where task, model and your steering vary together. `pi-evals exp` runs the same tasks twice, once per arm (for example without and with anchorloop), with the same model, so a difference can be put down to the arm. It runs from the CLI only; the extension never loads it.

A suite is a directory you keep: `suite.json` (model, thinking, an optional follow-up message every trial gets, paths no trial may touch), `arms/<name>.json` (extensions, skills and system-prompt files an arm adds), and `tasks/<id>/` with `task.json`, `prompt.md`, an optional `setup.sh`, a hidden `check/check.sh`, and the reference solution (`reference.patch`, or `reference.md` and a fact list for a task that must change nothing).

```sh
pi-evals exp check <suite> [--task id]...     # base fails the check, reference passes it 3 of 3
pi-evals exp run <suite> --arms a,b --k 3 [--tasks a,b] [--parallel 3] [--run-id id]
pi-evals exp grade <run-id>                    # regrade stored trials after a grader fix
pi-evals exp show <run-id> [--json]            # per-arm rates, B − A with a 95% CI, per-task table
pi-evals exp label <run-id> [--answer <file|->]
```

Each task's starting tree is built once as a single fresh commit (no history, remote or later commits) and cloned per trial into a temporary directory. pi runs headless with its own agent dir and session dir. The hidden check is copied in only after the agent ends. Outcome comes from `check.sh`, or for a must-not-change task from a clean tree plus the fact list. Process comes from the same detectors the report uses. A tool call that touches the original repository, pi's sessions or the suite's tasks makes the trial invalid; it is rerun once. The run stops at the first quota refusal. Trials are interleaved per task (A1 B1 A2 B2 …), so a stopped run stays paired.

`exp show` gives pass@1, pass^k (all of k trials pass), the process rates, cost and minutes per trial, and B − A with a paired cluster-bootstrap 95% CI over tasks. `exp label` writes a form page listing the trials where the arms disagree, without saying which arm ran them; `--answer` stores your verdicts in `labels.jsonl` with `source: "experiment"`. `exp show` compares them with the graders, and the monitoring report leaves them out.

Runs are kept in `~/.local/state/pi-evals/experiments/<run-id>/` and built fixtures in `~/.local/state/pi-evals/fixtures/`.

### The `evals_query` tool

Start with `findings` (under 1,500 bytes), then follow one pointer if you need the counts.
An agent calls `evals_query` with a `view` (`findings`, `items`, `labels`, `skills`, `packages`, `ask_user`, `monitors`, `subagents`, `process`, `cost`, `changes`, `coverage`) and optional `since` and `project`.
The result is plain text under 2 KB, covering the latest 30 UTC dates through the last extract unless you give `since`.
`findings` flags the biggest package error-rate rise and a rise in jobs ending in error when the later of two complete weeks is at least five percentage points higher, with at least 20 calls or endings in **each** week.
It also counts offered skills with no loads in the selected period and checks whether all old files are indexed.
The [analysis skill](skills/analyzing-evals/SKILL.md) includes three read-only commands for a change’s full comparison, a skill’s daily session counts, and a package’s daily errors.
The tool never starts an extract.
`labels` gives your labels by when they were given, how often the code checks agree with them, and the corrections agents logged; `findings` adds a line when three or more corrections share a rule and failure type.

### The `evals_label` tool

When you correct how an agent worked (it skipped a check, worked in the wrong order, ignored a rule), it calls `evals_label` once with `rule` (a check name or `other`) and an optional `type`: `no_check_stated`, `no_check_run`, `skipped_rule`, `wrong_order`, `unverified_claim`, `ignored_instruction` or `other`.
The row also keeps the session, the time, the item in progress, and the skills the session had loaded.
The count covers corrections the agent logged, not all its mistakes.
During a turn started by `/evals label <your words>`, the agent passes `on_behalf: "user"` and your verdict (`label`: `pass`, `fail` or `unclear`); that row is your label, not a correction.
At any other time `on_behalf` is refused, and the agent's own label can only be a fail.
The tool adds about 690 bytes of tool text to each session.

## The report

Open `report.html` for the last 30 UTC dates, including the day of the last extract.
The links at the top switch to 14 days, 90 days or all time; each opens another offline page in the same directory, with no scripts or external assets.
Each page has a matching `model*.json` with the numbers it shows.
`--since` or `--days` writes `report-custom.html` and `model-custom.json` without replacing the preset pages.
Every number in the model carries a plain-language label, what it means, which direction is better, and how it is computed, in English and Traditional Chinese.
### Reading the report

The strip below the date switch counts the changes by kind; its labeled marks open the highlighted comparisons.
Start with the sentence above the timeline: it says what changed in the numbers; the next line tells you what limits the comparison.
Open a card to see which sessions started before and after the change.
Read the count beside each rate: a check that applies to 48 sessions can say nothing about the other 116 sessions in a group of 164.
If the window is short, or other changes landed in the same period, do not credit a difference to the new version alone.

The sidebar shows workload for the selected dates, with markers on days you changed the setup.
A change appears on the timeline by its own date; its before-and-after comparison can reach beyond the selected dates.
The cleanup check always considers **all** old files, so selecting two weeks cannot hide an unindexed file from last year.
The date disclosures keep the rest of the timeline available without putting hundreds of cards on the first screen.
Use the section links for usage, process checks, cost and cleanup coverage, or read the [five concepts with a worked example](docs/learn.zh-TW.md).

## Settings

`$XDG_CONFIG_HOME/pi-evals/settings.json` (default `~/.config/pi-evals/settings.json`), all optional:

```json
{
  "extraRoots": ["/path/to/session-trash"],
  "changeRepos": ["~/projects/weihung-basic-agent", "~/projects/weihung-agent-root"],
  "coverageDays": 60,
  "impactWindowDays": 7
}
```

- `extraRoots`: more directories of session files to back-fill, such as a retention tool's trash. `PI_EVALS_ROOTS` (colon-separated) adds more.
- `changeRepos`: repositories whose `git log` feeds the change timeline. A leading `~` means your home directory.
- `coverageDays`: the age, in days without changes, at which a session file counts as old in the coverage figure.
- `impactWindowDays`: days on each side of a change in the before-and-after comparison.

`PI_EVALS_STATE_DIR` moves the state dir; `PI_CODING_AGENT_DIR` points at another pi agent dir.

## Files

| Path under the state dir | Contents |
| --- | --- |
| `events/<YYYY-MM-DD>.jsonl` | Live observer records. |
| `index/records/<YYYY-MM>/<key>.jsonl` | Back-filled records, one file per session file. |
| `index/checkpoint.json` | Size, modification time, summary and the extractor version that wrote it, per session file. |
| `index/days.json` | Aggregates by day and project. |
| `index/sessions.json` | A few numbers per session with its start time, for splitting sessions at a change's time. |
| `index/session-evals.json` | Process check results per session, for joining your labels. |
| `index/items.json`, `index/workitems.jsonl` | Work items joined across sessions, and their `pi.workitem` and `pi.stall` records. |
| `index/lines.json` | Cached `git diff --numstat` line counts between evidence commits. |
| `changes.jsonl`, `marks.jsonl` | The change timeline and your notes. |
| `labels.jsonl` | Your labels and agents' corrections, appended one per line ([docs/schema.md](docs/schema.md#labels)). The report shows how often you and the automatic checks agree, split by labels given after the fact and in the moment; `unclear` labels are counted apart. Its 「被糾正」 section counts the corrections by rule, failure type, skill loaded and anchorloop version. |
| `asks.jsonl` | One row per `/ask-ai`: session, time, project and todo item, without the question ([docs/schema.md](docs/schema.md#asks)). |
| `reports/report.html`, `reports/model.json` | The report. |

The record format is in [docs/schema.md](docs/schema.md); the decisions behind it are in [docs/design.md](docs/design.md).

## License

MIT
