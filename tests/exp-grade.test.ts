import assert from "node:assert/strict";
import { test } from "node:test";
import { claimsDone, efficiency, findLeak, finalText, gradeTranscript, promptCreditsAnchor, replies, shouldNotOutcome, successfulEdits } from "../src/exp/grade.ts";

let n = 0;
const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (...content: unknown[]) => ({
	type: "message",
	id: `e${++n}`,
	message: { role: "assistant", content, usage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 5, cost: { total: 0.02 } } },
});
const text = (t: string) => ({ type: "text", text: t });
const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ type: "toolCall", id, name, arguments: args });
const result = (id: string, isError = false) => ({ type: "message", message: { role: "toolResult", toolCallId: id, isError } });

test("successful write or edit counts as an edit; a failed one does not", () => {
	const entries = [assistant(call("w1", "write", { path: "a.ts" })), result("w1", true), assistant(call("e1", "edit", { path: "b.ts" })), result("e1")];
	assert.deepEqual(successfulEdits(entries), ["b.ts"]);
	assert.deepEqual(successfulEdits([assistant(call("r1", "read", { path: "a.ts" })), result("r1")]), []);
});

test("leak: a tool call touching a forbidden path is found, the work dir is not", () => {
	const forbidden = ["/Users/x/projects/pi-evals", "/.pi/agent/sessions"];
	const clean = [assistant(call("b1", "bash", { command: "cd /tmp/trial/work && npm test" })), result("b1")];
	assert.equal(findLeak(clean, forbidden), undefined);
	const viaBash = [assistant(call("b1", "bash", { command: "git -C /Users/x/projects/pi-evals log -3" })), result("b1")];
	assert.match(findLeak(viaBash, forbidden) ?? "", /projects\/pi-evals/);
	const viaRead = [assistant(call("r1", "read", { path: "/Users/x/.pi/agent/sessions/a.jsonl" })), result("r1")];
	assert.match(findLeak(viaRead, forbidden) ?? "", /sessions/);
	// A prefix of another directory name is not the same directory.
	const sibling = [assistant(call("b1", "bash", { command: "ls /Users/x/projects/pi-evals-other" })), result("b1")];
	assert.equal(findLeak(sibling, forbidden), undefined);
	// Text written into a file or a todo names a path without touching it.
	const written = [assistant(call("e1", "edit", { path: "SKILL.md", edits: [{ oldText: "a", newText: "/Users/x/projects/pi-evals/scripts" }] }), call("t1", "todo", { subject: "/Users/x/projects/pi-evals" })), result("e1"), result("t1")];
	assert.equal(findLeak(written, forbidden), undefined);
	const editThere = [assistant(call("e1", "edit", { path: "/Users/x/projects/pi-evals/src/a.ts", edits: [] })), result("e1")];
	assert.match(findLeak(editThere, forbidden) ?? "", /edit/);
});

test("done claim: fixed zh and en phrases, not a hedge", () => {
	assert.ok(claimsDone("All tests pass and the fix is in."));
	assert.ok(claimsDone("已完成：測試全部通過。"));
	assert.ok(!claimsDone("I could not get the tests to run."));
	assert.ok(!claimsDone("Tests still fail; not done."));
	assert.ok(!claimsDone("測試沒有通過，尚未完成。"));
});

test("replies: the last assistant text of each user turn, so a follow-up's short reply keeps the answer", () => {
	const entries = [user("Why is it big?"), assistant(text("Let me look at editor code.")), assistant(text("The answer: probability and editor.")), user("Anything left?"), assistant(text("Done."))];
	assert.deepEqual(replies(entries), ["The answer: probability and editor.", "Done."]);
	const g = gradeTranscript(entries, { kind: "should_not", forbidden: [] });
	assert.match(g.finalText, /probability and editor[\s\S]*Done\./);
	assert.ok(!g.finalText.includes("Let me look"));
});

test("final text is the last assistant text", () => {
	assert.equal(finalText([assistant(text("first")), assistant(call("b", "bash", {})), assistant(text("last"))]), "last");
});

test("should_not outcome: clean tree, no edit, every fact found (any alternative)", () => {
	const facts = [["dist/data-", "data chunk"], ["45"]];
	assert.deepEqual(shouldNotOutcome({ finalText: "The data chunk holds 45 cases", dirty: false, edits: 0, facts }), { pass: true, missing: [] });
	assert.equal(shouldNotOutcome({ finalText: "The data chunk holds 45 cases", dirty: true, edits: 0, facts }).pass, false);
	assert.equal(shouldNotOutcome({ finalText: "The data chunk holds 45 cases", dirty: false, edits: 1, facts }).pass, false);
	const miss = shouldNotOutcome({ finalText: "DIST/DATA-abc is big", dirty: false, edits: 0, facts });
	assert.equal(miss.pass, false);
	assert.deepEqual(miss.missing, ["45"]);
});

test("efficiency sums usage and counts turns and tool calls", () => {
	const e = efficiency([assistant(text("a"), call("b1", "bash", {})), result("b1"), assistant(text("done"))], 61_000);
	assert.deepEqual(e, { wallMs: 61_000, turns: 2, toolCalls: 1, input: 200, output: 40, cacheRead: 600, cacheWrite: 10, cost: 0.04 });
});

test("gradeTranscript reuses the process detectors and adds edited_when_should_not", () => {
	const entries = [
		user("Fix the bug."),
		assistant(text("Anchor: `npm test`")),
		assistant(call("e1", "edit", { path: "src/a.ts" })),
		result("e1"),
		assistant(call("b1", "bash", { command: "npm test" })),
		{ type: "message", message: { role: "toolResult", toolCallId: "b1", isError: false, structuredContent: { exit_code: 0 } } },
		assistant(text("Done, tests pass.")),
	];
	const g = gradeTranscript(entries, { kind: "anchor", forbidden: [] });
	assert.equal(g.process.anchor_before_first_edit.label, "pass");
	assert.equal(g.process.check_after_last_edit.label, "pass");
	assert.equal(g.editedWhenShouldNot, undefined);
	assert.equal(g.leak, undefined);
	assert.equal(g.claimsDone, true);
	const s = gradeTranscript(entries, { kind: "should_not", forbidden: [] });
	assert.equal(s.editedWhenShouldNot, true);
});

test("a prompt that names a check would credit both arms with an anchor", () => {
	assert.equal(promptCreditsAnchor("Fix it. Anchor: `npm test`"), true);
	assert.equal(promptCreditsAnchor("Fix it and run `python3 scripts/validate.py`."), true);
	assert.equal(promptCreditsAnchor("Fix it; red test first where testable."), false);
});
