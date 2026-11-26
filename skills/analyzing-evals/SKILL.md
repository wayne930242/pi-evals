---
name: analyzing-evals
description: Use when the user asks how their agents, skills or packages are doing, what a setup change did, or how to read the pi-evals report.
---

# Analyze agent activity

1. Call `evals_query` with `view: "findings"` first. Check the dates and last extraction; default is the latest 30 UTC dates in the index. Use `since` or `project` when the question specifies a narrower scope.
2. Follow **one** pointer that answers the question. For a weekly change in tool errors use `packages`; for a rule about editing use `process`. Keep the same filters. Stop when the numbers answer the question.
3. If one detail is still missing, run one script below. Resolve `../../scripts` **from the directory containing this SKILL.md**, not from the user's checkout. Set `SCRIPTS` to that absolute path. Use exact identifiers returned by the view; none of these commands reads a transcript.

```sh
node "$SCRIPTS/change-impact.mjs" UTC_TIMESTAMP_OR_SHA [PACKAGE_OR_KIND]
node "$SCRIPTS/skill-days.mjs" SKILL [PROJECT]
node "$SCRIPTS/package-errors.mjs" PACKAGE [PROJECT]
```

The first reads the saved `reports/model.json`: check its extract time and project before using the comparison. For a different saved page, prefix the command with `PI_EVALS_REPORT_RANGE=14`, `90`, `all` or `custom`. If the file is missing or out of date, say so; `/evals report` rebuilds the preset pages.
The other two read the last 14 complete UTC dates in the index. Skill sessions count on their start date; package errors count on the date of the call. Neither script treats zero calls as a 0% error rate.

Lead with what rose, fell or held steady, and give the counts behind the rates. Say “too early to tell” when a side is short or too small; when other changes landed nearby, say “we cannot tell which change mattered.” Even a clear difference is not proof of cause. More sessions or skill loads measure activity, not better work.
