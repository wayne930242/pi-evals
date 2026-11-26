import assert from "node:assert/strict";
import { test } from "node:test";
import { flipped, summarize, trialValue } from "../src/exp/summary.ts";
import type { TrialRecord } from "../src/exp/trial.ts";

const eff = { wallMs: 120_000, turns: 3, toolCalls: 4, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.5 };
function rec(task: string, kind: TrialRecord["kind"], arm: string, n: number, outcome: boolean, anchor = "pass", check = "pass", extra: Partial<TrialRecord> = {}): TrialRecord {
	return {
		task, kind, arm, n, valid: true, outcome, dirty: false, claimsDone: false, doneClaimVsOutcome: false, notices: 0, timedOut: false, quota: false, efficiency: eff, workDir: "",
		process: { anchor_before_first_edit: { label: anchor, explanation: "" }, check_after_last_edit: { label: check, explanation: "" }, todo_evidence: { label: "na", explanation: "" }, close_guard_quiet: { label: "pass", explanation: "" } },
		...extra,
	};
}

test("process counts only change tasks where a change was made; should_not counts edits", () => {
	assert.equal(trialValue(rec("t", "anchor", "a", 1, true, "pass", "fail"), "process"), 0);
	assert.equal(trialValue(rec("t", "anchor", "a", 1, true, "na", "na"), "process"), undefined);
	assert.equal(trialValue(rec("t", "should_not", "a", 1, true), "process"), undefined);
	assert.equal(trialValue(rec("t", "should_not", "a", 1, true, "na", "na", { editedWhenShouldNot: true }), "edited_when_should_not"), 1);
});

test("summary: per-arm rates are means over tasks; pass^3 needs all three; invalid and replaced trials drop out", () => {
	const records = [
		...[1, 2, 3].map((n) => rec("t1", "anchor", "bare", n, n !== 2, "fail", "pass")),
		...[1, 2, 3].map((n) => rec("t1", "anchor", "anchorloop", n, true)),
		...[1, 2, 3].map((n) => rec("t2", "light", "bare", n, true, "fail", "fail")),
		...[1, 2, 3].map((n) => rec("t2", "light", "anchorloop", n, true)),
		{ ...rec("t2", "light", "anchorloop", 3, false), valid: false, invalid: "leak: x" },
	];
	// The invalid record came last for t2/anchorloop/3, so that slot drops out.
	const s = summarize(records, ["bare", "anchorloop"], { resamples: 500, seed: 1 });
	const bare = s.arms.find((a) => a.arm === "bare")!;
	const al = s.arms.find((a) => a.arm === "anchorloop")!;
	assert.equal(bare.metrics.outcome, (2 / 3 + 1) / 2);
	assert.equal(bare.metrics.outcome_pass3, 0.5);
	assert.equal(al.metrics.outcome_pass3, 1);
	assert.equal(bare.metrics.process, 0);
	assert.equal(al.metrics.process, 1);
	assert.equal(al.trials, 5);
	assert.equal(al.invalid, 1);
	assert.equal(s.deltas.process?.delta, 1);
	assert.equal(bare.minutesPerTrial, 2);
	assert.equal(s.tasks[0].task, "t2", "the smallest delta comes first");
});

test("flipped: tasks where the arms differ, plus done claims on a failed check", () => {
	const same = [rec("t1", "anchor", "bare", 1, true), rec("t1", "anchor", "anchorloop", 1, true)];
	const differ = [rec("t2", "anchor", "bare", 1, true, "fail"), rec("t2", "anchor", "anchorloop", 1, true)];
	const claim = rec("t3", "anchor", "bare", 1, false, "pass", "pass", { doneClaimVsOutcome: true });
	const out = flipped([...same, ...differ, claim, rec("t3", "anchor", "anchorloop", 1, false)], ["bare", "anchorloop"]);
	assert.deepEqual(out.map((r) => `${r.task}/${r.arm}`).sort(), ["t2/anchorloop", "t2/bare", "t3/bare"]);
});
