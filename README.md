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
- **Your changes**: package pins, model routing, rules, skills and agent roles from the git history of your setup repositories, version changes seen live, and notes you add with `/evals mark`, each with the same numbers in the days before and after.

## Privacy

Records hold derived facts only: names (tools, skills, packages, models, roles, project keys), counts, durations, exit codes, outcomes, and token and cost numbers.
They never hold transcript text, tool arguments, file contents, commands, questions, or answers.
Every string written to a record must look like a name (no spaces, no line breaks, at most 160 characters), or it is stored as `redacted`.
A test plants a secret in every text field of a session and checks that it reaches no output file and no query result.

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
| `/evals extract` | Back-fills past sessions in a background process; progress shows in the footer. Only files whose size or modification time changed are read again. |
| `/evals report [--since YYYY-MM-DD] [--project <key>]` | Builds the report and prints its path. |
| `/evals mark <note>` | Adds a note to the change timeline, e.g. `/evals mark workers moved to gpt-6.2-astra`. |

The same operations run from a shell:

```sh
pi-evals extract [--root <dir>]... [--workers <n>] [--json]
pi-evals report [--out <dir>] [--since YYYY-MM-DD] [--project <key>] [--lang zh|en]
pi-evals status
pi-evals query <view> [--since YYYY-MM-DD] [--project <key>]
pi-evals mark <note>
```

### The `evals_query` tool

An agent calls `evals_query` with a `view` (`skills`, `packages`, `ask_user`, `monitors`, `subagents`, `process`, `cost`, `changes`, `coverage`) and optional `since` and `project`.
The result is a plain-text summary under 2 KB with the report path; it says when the data is more than a day old.
The tool never starts an extract.

## The report

One HTML file with no scripts, no network requests and no external assets; charts are inline SVG, and it follows the system's light or dark setting.
It is written as `report.html` next to `model.json`, the ReportModel it is rendered from.
Every number in the model carries a plain-language label, what it means, which direction is better, and how it is computed, in English and Traditional Chinese.
The renderer reads only the model, so a redesigned report can replace it without touching the data.

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
| `changes.jsonl`, `marks.jsonl` | The change timeline and your notes. |
| `labels.jsonl` | Your labels, when you add them (a later phase): `{ "session_id", "evaluation_name", "label": "pass" \| "fail" }` per line. The report then shows how often you and the automatic checks agree. |
| `reports/report.html`, `reports/model.json` | The report. |

The record format is in [docs/schema.md](docs/schema.md); the decisions behind it are in [docs/design.md](docs/design.md).

## License

MIT
