# pi-evals

Records of how [pi](https://github.com/earendil-works/pi) agents use skills, packages, ask-user, monitors and subagents, and whether their work follows the anchorloop process rules.
It reads past session files once, keeps a small observer running for what those files do not hold, and builds a static HTML report.
Agents can read the same numbers through one tool, `evals_query`.

## What it records

- **Skills**: loads per day and per project, how each was loaded (a read of its `SKILL.md`, a `/skill:` command, a subagent role's declared skills, a shell `cat` of the file), and the skills pi offers that no agent loaded.
- **Packages**: tool calls, errors and run time grouped by the package that registered each tool.
- **Ask-user**: questions asked, how long you took to answer, how many you dismissed, and whether the answer came from the terminal or a remote channel.
- **Monitors**: background jobs by outcome and duration.
- **Subagents**: launches by role and model, and their cost by role.
- **Process**: four checks of the anchorloop rules per session, for sessions started after anchorloop 3.0.0 was pinned (2026-11-23T10:51:07Z); see [docs/design.md](docs/design.md#process-detectors).
- **Cost**: model cost and tokens, and the cost of the sessions that loaded each skill.
- **Work items**: each todo task from the moment it is switched to in progress until it is done or deleted: what it cost (subagents exactly, the main agent as an even share), where it closed (reviewer approval, a landed car, a wrap, evidence), where it stalled and on whom, and whether one way of working is cheaper than another of the same kind.
- **Your changes**: package pins, model routing, rules, skills and agent roles from the git history of your setup repositories, version changes seen live, and notes you add with `/evals mark`, each with the same numbers in the days before and after.

## Privacy

Records hold derived facts only: names (tools, skills, packages, models, roles, project keys), counts, durations, exit codes, outcomes, and token and cost numbers.
They never hold transcript text, tool arguments, file contents, commands, questions, or answers.
Every string written to a record must look like a name (no spaces, no line breaks, at most 160 characters), or it is stored as `redacted`.
The one exception is a work item's title: its todo subject, cut to one line of at most 80 characters.
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

The same operations run from a shell, where extraction defaults to one fewer worker than available CPUs (at least one, at most eight).
On either surface, `--workers 0` reads the files sequentially without worker threads:

```sh
pi-evals extract [--root <dir>]... [--workers <n>] [--json]
pi-evals report [--out <dir>] [--since YYYY-MM-DD | --days N] [--project <key>] [--lang zh|en]
pi-evals status
pi-evals query <view> [--since YYYY-MM-DD] [--project <key>]
pi-evals mark <note>
```

### The `evals_query` tool

Start with `findings` (under 1,500 bytes), then follow one pointer if you need the counts.
An agent calls `evals_query` with a `view` (`findings`, `items`, `skills`, `packages`, `ask_user`, `monitors`, `subagents`, `process`, `cost`, `changes`, `coverage`) and optional `since` and `project`.
The result is plain text under 2 KB, covering the latest 30 UTC dates through the last extract unless you give `since`.
`findings` flags the biggest package error-rate rise and a rise in jobs ending in error when the later of two complete weeks is at least five percentage points higher, with at least 20 calls or endings in **each** week.
It also counts offered skills with no loads in the selected period and checks whether all old files are indexed.
The [analysis skill](skills/analyzing-evals/SKILL.md) includes three read-only commands for a change’s full comparison, a skill’s daily session counts, and a package’s daily errors.
The tool never starts an extract.

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
| `index/checkpoint.json` | Size, modification time and summary per session file. |
| `index/days.json` | Aggregates by day and project. |
| `index/sessions.json` | A few numbers per session with its start time, for splitting sessions at a change's time. |
| `index/session-evals.json` | Process check results per session, for joining your labels. |
| `index/items.json`, `index/workitems.jsonl` | Work items joined across sessions, and their `pi.workitem` and `pi.stall` records. |
| `index/lines.json` | Cached `git diff --numstat` line counts between evidence commits. |
| `changes.jsonl`, `marks.jsonl` | The change timeline and your notes. |
| `labels.jsonl` | Your labels, when you add them (a later phase): `{ "session_id", "evaluation_name", "label": "pass" \| "fail" \| "unclear" }` per line. The report then shows how often you and the automatic checks agree; `unclear` labels are counted apart. |
| `reports/report.html`, `reports/model.json` | The report. |

The record format is in [docs/schema.md](docs/schema.md); the decisions behind it are in [docs/design.md](docs/design.md).

## License

MIT
