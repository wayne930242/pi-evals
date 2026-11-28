---
name: analyzing-evals
description: Use when the user asks how their agents, skills or packages are doing, what a setup change did, or how to read the pi-evals report.
---

# Analyze agent activity

1. Run `node "$SCRIPTS/freshness.mjs"` (step 3 says how to find `SCRIPTS`); if it exits 1, say the numbers are stale and stop. Then call `evals_query` with `view: "findings"`. Check the dates and last extraction; default is the latest 30 UTC dates in the index. Use `since` or `project` when the question specifies a narrower scope.
2. Follow **one** pointer that answers the question. For a weekly change in tool errors use `packages`; for a rule about editing use `process`; for what a piece of work cost, where it closed, where it stalled, or whether one way of working is cheaper, use `items`; for how far the code checks match the user's labels, or what the user corrected, use `labels`. Keep the same filters. Stop when the numbers answer the question.
3. If one detail is still missing, run one script below. Set `SCRIPTS` to the absolute path on the `Scripts:` line or in `details.scriptsDir`. For a default npm install, the fallback is `SCRIPTS="$HOME/.pi/agent/npm/node_modules/pi-evals/scripts"`. Check `test -f "$SCRIPTS/query-lib.mjs"` before running a query; if it fails, stop rather than guessing another path. Use exact identifiers returned by the view; none of these commands reads a transcript.

```sh
node "$SCRIPTS/change-impact.mjs" UTC_TIMESTAMP_OR_SHA [PACKAGE_OR_KIND]
node "$SCRIPTS/skill-days.mjs" SKILL [PROJECT]
node "$SCRIPTS/package-errors.mjs" PACKAGE [PROJECT]
node "$SCRIPTS/by-version.mjs" DETECTOR [--pkg PACKAGE]
```

The first reads the saved `reports/model.json`: check its extract time and project before using the comparison. For a different saved page, prefix the command with `PI_EVALS_REPORT_RANGE=14`, `90`, `all` or `custom`. If the file is missing or out of date, say so; `/evals report` rebuilds the preset pages.
The other two read the last 14 complete UTC dates in the index. Skill sessions count on their start date; package errors count on the date of the call. Neither script treats zero calls as a 0% error rate.

Reading `labels`: agreement counts the user's verdicts only, split into after the fact (from summaries) and in the moment (`/evals label`); corrections are what agents logged with `evals_label`, not all their mistakes, so do not read a count as an error rate.

Reading `items`: an item is one todo task from `in_progress` to done or deleted. Subagent cost is exact; main cost is an estimate, split evenly among items in progress at the same moment, so say which part you quote. Compare only like with like (the view already separates work handed to subagents from work the main did itself); when it says "too few items to tell", say that in those words rather than reading the medians. A stall says what woke the main (`human`, `peer`, `child`, `timer`, `ci`, `device`), not why it waited; `on` names the subagent, peer session or sb wait (`W12`, `L340`, `T5`) when known.

Reading a change alert (the session-start line, `/evals alerts`, or `pi-evals alerts` from a shell): it fires when a check's pass rate in the sessions after a change is at least 10 points lower than before, with z ≥ 3 and at least 20 applicable sessions a side. It names the change point that best splits the drop, so nearby changes (the `other change points` count) may share the cause. Report the counts it gives and say it is a drop worth looking into, not proof the change caused it; follow it with `process` or `by-version.mjs` for that check.

Lead with what rose, fell or held steady, and give the counts behind the rates. Say “too early to tell” when a side is short or too small; when other changes landed nearby, say “we cannot tell which change mattered.” Even a clear difference is not proof of cause. More sessions or skill loads measure activity, not better work.

## When a number looks wrong

1. Check freshness first (`freshness.mjs`): the last extract time, and the extractor version on the summaries against the current one. A run stopped mid-way once left old summaries under a new checkpoint (check agreement read 11/20; a clean rebuild gave 23/24). If they disagree, say the number is stale and do not interpret it.
2. Before trusting a detector's rate, check it against the user's labels: the `labels` view, then `disagree.mjs RULE` for the disagreeing sessions one by one and which way they lean. All code=fail with human=pass means the detector undercounts (an anchor rate read 20% that was about 73%).
3. Error analysis: read each disagreeing session's structure with `session-shape.mjs SESSION_ID` (events in order, no message text), group the misses by cause, count each group, and fix the biggest first.
4. When loosening a detector, keep a guard set of real should-fail sessions that must stay fail. A rule ambiguity (an anchor stated after the first edit) is the user's decision: ask, record it as a `recheck` label, and do not settle it silently in code.
5. Have the user label about 30 sessions by hand before trusting any automated grader (`sample.mjs 30` picks them, `label-import.mjs ANSWER_FILE` records the answers); human labels are the reference. Observational numbers are monitoring; whether skill X helped needs a controlled experiment, not this report.

The user runs any of these as `/evals run <script> [args]`; `/evals run` alone lists them.
