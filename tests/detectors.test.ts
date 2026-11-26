import assert from "node:assert/strict";
import { test } from "node:test";
import { type DetectorName, noticeKind, ProcessTracker } from "../src/detectors.ts";

let n = 0;
const assistant = (...content: unknown[]) => ({ type: "message", id: `e${++n}`, message: { role: "assistant", content } });
const text = (t: string) => ({ type: "text", text: t });
const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ type: "toolCall", id, name, arguments: args });
const result = (id: string, opts: { isError?: boolean; exit?: number } = {}) => ({
	type: "message",
	id: `e${++n}`,
	message: { role: "toolResult", toolCallId: id, isError: opts.isError ?? false, ...(opts.exit === undefined ? {} : { structuredContent: { exit_code: opts.exit } }) },
});
const todo = (tasks: unknown[]) => ({ type: "custom", customType: "todo/v1", data: { v: 1, nextId: 9, tasks } });
const notice = (content: string) => ({ type: "custom_message", customType: "anchorloop-close-guard", content });

function run(entries: unknown[], inScope = true) {
	const tracker = new ProcessTracker();
	for (const entry of entries) tracker.feed(entry);
	return Object.fromEntries(tracker.results(inScope).map((r) => [r.name, r])) as unknown as Record<DetectorName, { label: string; value?: number; explanation: string }>;
}

const edit = (id: string) => [assistant(call(id, "edit", { path: "a.ts" })), result(id)];
const bash = (id: string, command: string, exit: number) => [assistant(call(id, "bash", { command })), result(id, { exit, isError: exit !== 0 })];

test("anchor before first edit: pass when the Anchor line precedes the first change", () => {
	const r = run([assistant(text("Plan.\nAnchor: `npm test`")), ...edit("c1"), ...bash("b1", "npm test", 0)]);
	assert.equal(r.anchor_before_first_edit.label, "pass");
});

test("anchor before first edit: fail when the anchor comes only after the first change", () => {
	const r = run([...edit("c1"), assistant(text("Anchor: `npm test`")), ...edit("c2")]);
	assert.equal(r.anchor_before_first_edit.label, "fail");
	assert.equal(r.anchor_before_first_edit.explanation, "change_before_anchor");
});

test("anchor before first edit: a todo anchor counts, a failed edit is no change, no change is na", () => {
	assert.equal(run([assistant(call("t1", "todo", { action: "create", subject: "x", anchor: "npm test" })), result("t1"), ...edit("c1")]).anchor_before_first_edit.label, "pass");
	const failedEdit = run([assistant(call("c0", "edit")), result("c0", { isError: true }), assistant(text("Anchor: `npm test`")), ...edit("c1")]);
	assert.equal(failedEdit.anchor_before_first_edit.label, "pass");
	assert.equal(run([...bash("b1", "ls", 0)]).anchor_before_first_edit.label, "na");
});

test("check after last edit: pass when every anchor command passed after the last change", () => {
	const r = run([assistant(text("Anchor: `npm run check` and `npm test`")), ...edit("c1"), ...bash("b1", "npm run check", 0), ...bash("b2", "cd x && npm test", 0)]);
	assert.equal(r.check_after_last_edit.label, "pass");
});

test("check after last edit: fail when the latest run failed or ran before the last change", () => {
	assert.equal(run([assistant(text("Anchor: `npm test`")), ...edit("c1"), ...bash("b1", "npm test", 1)]).check_after_last_edit.label, "fail");
	const stale = run([assistant(text("Anchor: `npm test`")), ...edit("c1"), ...bash("b1", "npm test", 0), ...edit("c2")]);
	assert.equal(stale.check_after_last_edit.label, "fail");
	assert.equal(stale.check_after_last_edit.explanation, "no_passing_run_after_change");
});

test("check after last edit: na without an anchor, or with an anchor that names no command", () => {
	assert.equal(run([...edit("c1")]).check_after_last_edit.explanation, "no_anchor");
	assert.equal(run([assistant(text("Anchor: the reviewer approves")), ...edit("c1")]).check_after_last_edit.explanation, "anchor_without_command");
});

test("todo evidence: share of completed tasks carrying evidence, from the newest snapshot", () => {
	const r = run([
		todo([{ id: 1, subject: "a", status: "completed" }]),
		todo([
			{ id: 1, subject: "a", status: "completed", evidence: [{ command: "npm test", result: "pass", at: "x" }] },
			{ id: 2, subject: "b", status: "completed" },
			{ id: 3, subject: "c", status: "pending" },
		]),
	]);
	assert.equal(r.todo_evidence.label, "fail");
	assert.equal(r.todo_evidence.value, 0.5);
	const all = run([todo([{ id: 1, subject: "a", status: "completed", evidence: [{ command: "x", result: "pass" }] }])]);
	assert.equal(all.todo_evidence.label, "pass");
	assert.equal(run([todo([{ id: 1, subject: "a", status: "pending" }])]).todo_evidence.label, "na");
});

test("close guard quiet: fail with the commonest notice kind, pass with none, na without a change", () => {
	const noisy = run([...edit("c1"), notice("anchorloop: files changed, but no `Anchor: <check>` line was stated; state it.")]);
	assert.equal(noisy.close_guard_quiet.label, "fail");
	assert.equal(noisy.close_guard_quiet.explanation, "no_anchor");
	assert.equal(run([assistant(text("Anchor: `x`")), ...edit("c1"), ...bash("b", "x", 0)]).close_guard_quiet.label, "pass");
	assert.equal(run([...bash("b", "x", 0)]).close_guard_quiet.label, "na");
});

test("notice kinds", () => {
	assert.equal(noticeKind("anchorloop: files changed, but no `Anchor: <check>` line was stated; state the check."), "no_anchor");
	assert.equal(noticeKind("anchorloop: no passing run of `npm test` after the last change."), "no_passing_run");
	assert.equal(noticeKind("anchorloop: use todo update on #3 to append each unrecorded passing run to evidence"), "evidence_handoff");
	assert.equal(noticeKind("something else"), "other");
});

test("sessions before anchorloop 3.0.0 are out of scope, not failures", () => {
	const r = run([...edit("c1")], false);
	for (const name of ["anchor_before_first_edit", "check_after_last_edit", "todo_evidence", "close_guard_quiet"] as const) {
		assert.equal(r[name].label, "na");
		assert.equal(r[name].explanation, "out_of_scope_pre_3.0");
	}
});

test("close guard quiet: an evidence hand-off reminder alone is not a failure", () => {
	const r = run([assistant(text("Anchor: `x`")), ...edit("c1"), ...bash("b", "x", 0), notice("anchorloop: use todo update on #2 to append each unrecorded passing run to evidence")]);
	assert.equal(r.close_guard_quiet.label, "pass");
});

test("anchor before first edit: a brief's Anchor the agent never restated is named as such", () => {
	const brief = { type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "Do it.\nAnchor: `npm test`" }] } };
	const r = run([brief, ...edit("c1")]);
	assert.equal(r.anchor_before_first_edit.label, "fail");
	assert.equal(r.anchor_before_first_edit.explanation, "anchor_only_in_brief");
});
