import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyLabelAnswer, labelAgreement, writeLabelQueue } from "../src/exp/labels.ts";
import type { RunMeta } from "../src/exp/run.ts";
import type { TrialRecord } from "../src/exp/trial.ts";
import { labelsModel, readLabels } from "../src/labels.ts";

const eff = { wallMs: 1, turns: 1, toolCalls: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "exp-labels-"));
	const meta = { id: "run1", arms: { bare: {}, anchorloop: {} }, k: 1 } as unknown as RunMeta;
	const rec = (arm: string, anchor: string, outcome: boolean): TrialRecord => {
		const session = join(dir, `${arm}.jsonl`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			session,
			[
				{ type: "session", id: `sess-${arm}`, version: 3 },
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "fix it" }] } },
				{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "r", name: "read", arguments: { path: `/x/evals/anchorloop/vendor/pi-anchorloop@3.5.0/skills/coding/SKILL.md` } }] } },
				{ type: "message", message: { role: "assistant", content: [{ type: "text", text: `final from ${arm === "bare" ? "one" : "two"}` }] } },
			].map((e) => JSON.stringify(e)).join("\n") + "\n",
		);
		return {
			task: "t1", kind: "anchor", arm, n: 1, valid: true, outcome, dirty: true, claimsDone: false, doneClaimVsOutcome: false, notices: 0, timedOut: false, quota: false, efficiency: eff, workDir: "", session,
			process: { anchor_before_first_edit: { label: anchor, explanation: "" }, check_after_last_edit: { label: "pass", explanation: "" } },
		};
	};
	return { dir, meta, records: [rec("bare", "fail", true), rec("anchorloop", "pass", true)] };
}

test("label queue: flipped trials only, blind to the arm, as a form page", () => {
	const { dir, meta, records } = setup();
	const q = writeLabelQueue(dir, meta, records);
	assert.equal(q.items.length, 2);
	const page = readFileSync(q.page, "utf8");
	assert.match(page, /```form/);
	assert.match(page, /q1_anchor_before_first_edit/);
	assert.ok(!/anchorloop|bare/.test(page.replace(/# 實驗標記.*\n/, "")), "the page never names an arm");
	assert.ok(!page.includes("vendor/pi-anchorloop"), "vendored skill paths are blanked");
});

test("label answer: rows carry source experiment and the trial, and stay out of the monitoring report", () => {
	const { dir, meta, records } = setup();
	const q = writeLabelQueue(dir, meta, records);
	const labels = join(dir, "labels.jsonl");
	const anchorloopQ = q.items.find((i) => i.arm === "anchorloop")!.q;
	const bareQ = q.items.find((i) => i.arm === "bare")!.q;
	const answer = `User submitted a form:\n- ${anchorloopQ}_anchor_before_first_edit: pass\n- ${anchorloopQ}_outcome: pass\n- ${anchorloopQ}_note: looked fine\n- ${bareQ}_anchor_before_first_edit: pass\n- ${bareQ}_check_after_last_edit: unclear\nOther comments: none\n`;
	const rows = applyLabelAnswer(dir, meta, answer, labels, "2026-11-26T12:00:00.000Z");
	assert.equal(rows.length, 4);
	assert.ok(rows.every((r) => r.source === "experiment" && r.project === "exp:run1" && r.annotator === "human"));
	assert.deepEqual(rows.find((r) => r.evaluation_name === "outcome")?.item, "t1/anchorloop/1");
	assert.equal(readLabels(labels).length, 4);
	const model = labelsModel(labels, join(dir, "missing-evals.json"), {}, () => undefined);
	assert.equal(model.n, 0);
	const agreement = labelAgreement(meta, records, labels);
	const anchor = agreement.find((a) => a.rule === "anchor_before_first_edit")!;
	assert.equal(anchor.n, 2);
	assert.equal(anchor.agree, 1);
	assert.deepEqual(anchor.disagree, ["t1/bare/1"]);
	assert.equal(agreement.find((a) => a.rule === "check_after_last_edit")?.unclear, 1);
});
