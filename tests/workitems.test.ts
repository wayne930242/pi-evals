import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionReader } from "../src/extract/session.ts";
import { setKnownProjects } from "../src/project.ts";
import { titleOf } from "../src/work/track.ts";
import { assistant, customMessage, type SessionSpec, sessionLines, stop, todo, user } from "./fixtures.ts";

const HOME = "/home/tester";
setKnownProjects(["demo-repo"]);
const SID = "01a20000-0000-7000-8000-0000000000a1";

function work(spec: Omit<SessionSpec, "id" | "cwd" | "start"> & { start?: string }, path = "/s/--x--/2026-11-25T10-00-00-000Z_main.jsonl") {
	const reader = new SessionReader(path, HOME);
	for (const line of sessionLines({ id: SID, cwd: `${HOME}/projects/demo-repo`, start: spec.start ?? "2026-11-25T10:00:00.000Z", entries: spec.entries }).split("\n")) reader.feedLine(line);
	const w = reader.finish().summary.work;
	assert.ok(w, "work extracted");
	return w;
}
const task = (id: number, status: string, more: Record<string, unknown> = {}) => ({ id, subject: `Task ${id}`, status, ...more });
const byKey = (w: ReturnType<typeof work>) => Object.fromEntries(w.items.map((i) => [i.key, i]));

test("transitions come from diffing snapshots; main cost is split evenly among items active at the same moment", () => {
	const w = work({
		entries: (t) => [
			user(t(0), "go"),
			todo(t(10), [task(1, "pending", { owner: "a-build" }), task(2, "pending", { blockedBy: [1] })]),
			todo(t(20), [task(1, "in_progress", { owner: "a-build" }), task(2, "pending", { blockedBy: [1] })]),
			assistant(t(30), [], 1),
			todo(t(40), [task(1, "in_progress", { owner: "a-build" }), task(2, "in_progress", { blockedBy: [1] })]),
			assistant(t(50), [], 2),
			stop(t(55)),
			customMessage(t(355), "subagent_result", "done", { name: "a-build" }),
			assistant(t(400), [], 0.5),
			todo(t(410), [task(1, "completed", { owner: "a-build", evidence: [{ command: "npm test", sha: "abc1234", result: "pass", at: t(410) }] }), task(2, "in_progress", { blockedBy: [1] })]),
			assistant(t(420), [], 1),
			stop(t(430)),
			user(t(630), "next"),
			todo(t(700), [task(1, "completed", { owner: "a-build", evidence: [{ command: "npm test", sha: "abc1234", result: "pass", at: t(410) }] }), task(2, "completed", { blockedBy: [1] }), task(3, "in_progress")]),
			todo(t(710), [task(1, "completed", { owner: "a-build", evidence: [{ command: "npm test", sha: "abc1234", result: "pass", at: t(410) }] }), task(2, "completed", { blockedBy: [1] }), task(3, "deleted")]),
			assistant(t(720), [], 0.3),
		],
	});
	const items = byKey(w);
	const one = items[`${SID}#1`];
	const two = items[`${SID}#2`];
	const three = items[`${SID}#3`];
	assert.equal(one.start, "2026-11-25T10:00:20.000Z");
	assert.equal(one.close, "2026-11-25T10:06:50.000Z");
	assert.equal(one.status, "completed");
	assert.equal(one.owner, "a-build");
	assert.deepEqual(one.shas, ["abc1234"]);
	assert.equal(one.evidence, 1);
	assert.equal(two.blockedBy, 1);
	assert.equal(two.created, "2026-11-25T10:00:10.000Z", "created at planning, started later");
	assert.equal(two.start, "2026-11-25T10:00:40.000Z");
	// #1 alone 1.0, both 2.0 → 1.0 each, both 0.5 → 0.25 each, #2 alone 1.0.
	assert.equal(one.mainCost, 2.25);
	assert.equal(two.mainCost, 2.25);
	assert.equal(three.status, "deleted");
	assert.equal(three.close, "2026-11-25T10:11:50.000Z");
	assert.equal(w.unattributed, 0.3, "cost outside every window stays unattributed");
	// The idle gap woken by the child is a child stall for both active items; the boss's prompt only for #2.
	assert.deepEqual(w.gaps.map((g) => [g.kind, g.on, g.via]), [["child", "a-build", "idle"], ["human", undefined, "idle"]]);
	assert.deepEqual(one.stalls, [[0, 300_000]]);
	assert.deepEqual(two.stalls, [[0, 300_000], [1, 200_000]]);
});

test("a clear restarts ids: the same id is a new item, never merged", () => {
	const w = work({
		entries: (t) => [
			todo(t(1), [{ id: 1, subject: "First", status: "in_progress" }]),
			todo(t(2), []),
			todo(t(3), [{ id: 1, subject: "Second", status: "in_progress" }]),
		],
	});
	const items = byKey(w);
	assert.equal(items[`${SID}#1`].title, "First");
	assert.equal(items[`${SID}#1`].status, "deleted", "cleared while active: dropped");
	assert.equal(items[`${SID}#1.2`].title, "Second");
	assert.equal(items[`${SID}#1.2`].status, "in_progress");
});

test("a /tree branch: the branch with the last snapshot wins; an item only on the other branch keeps its own key", () => {
	const w = work({
		entries: (t) => [
			{ ...todo(t(1), [task(1, "pending")]), id: "s1" },
			{ ...todo(t(2), [task(1, "in_progress")]), id: "s2" },
			{ ...todo(t(3), [task(1, "completed"), task(3, "pending")]), id: "s3" },
			{ ...todo(t(4), [task(1, "in_progress"), task(2, "pending")]), id: "s4", parentId: "s2" },
		],
	});
	const items = byKey(w);
	assert.equal(items[`${SID}#1`].status, "in_progress", "the rewound completion does not count");
	assert.equal(items[`${SID}#1`].close, undefined);
	assert.ok(items[`${SID}#2`]);
	assert.equal(items[`${SID}#3@s3`].title, "Task 3");
	assert.equal(w.items.length, 3);
});

test("producer fields when present: uid is the key, origin and evidence refs are kept", () => {
	const w = work({
		entries: (t) => [
			todo(t(1), [{ id: 4, subject: "Imported", status: "in_progress", uid: "t_abcdefghij", origin: { session: "01a2ffff-0000-7000-8000-000000000000" } }, { id: 5, subject: "Old style", status: "in_progress", origin: { session: "01a2eeee-0000-7000-8000-000000000000" } }]),
			todo(t(2), [{ id: 4, subject: "Imported", status: "completed", uid: "t_abcdefghij", origin: { session: "01a2ffff-0000-7000-8000-000000000000" }, evidence: [{ command: "x", result: "pass", at: t(2), ref: "child:11111111-2222-4333-8444-555555555555" }, { command: "y", result: "pass", at: t(2), ref: "has space" }] }, { id: 5, subject: "Old style", status: "in_progress", origin: { session: "01a2eeee-0000-7000-8000-000000000000" } }]),
		],
	});
	const items = byKey(w);
	const imported = items.t_abcdefghij;
	assert.equal(imported.uid, "t_abcdefghij");
	assert.equal(imported.origin, "01a2ffff-0000-7000-8000-000000000000");
	assert.deepEqual(imported.refs, ["child:11111111-2222-4333-8444-555555555555"], "a ref with a space is not a ref");
	assert.ok(items["01a2eeee-0000-7000-8000-000000000000#5"], "no uid: the origin session's key, so the item continues");
});

test("a question held open two minutes or more is a human stall; shorter idles are not stalls", () => {
	const w = work({
		entries: (t) => [
			todo(t(1), [task(1, "in_progress")]),
			assistant(t(2), [{ type: "toolCall", id: "q1", name: "ask_user_question", arguments: { questions: [{}] } }]),
			{ type: "message", timestamp: t(200), message: { role: "toolResult", toolCallId: "q1", toolName: "ask_user_question", content: [], isError: false, details: { answers: [] } } },
			stop(t(210)),
			customMessage(t(250), "intercom_message", "hi", { from: { id: "01a20d4d-548e-7202-bbc8-588e8ad6e013" } }),
			stop(t(260)),
			customMessage(t(600), "intercom_message", "hi", { from: { id: "01a20d4d-548e-7202-bbc8-588e8ad6e013" } }),
			stop(t(610)),
			customMessage(t(900), "pi-loop-monitor", "x", { deliveryGroup: "monitor-terminal", monitorOutcome: { monitorId: "3" } }),
			stop(t(910)),
		],
	});
	assert.deepEqual(w.gaps.map((g) => [g.kind, g.on, g.via, (Date.parse(g.end) - Date.parse(g.start)) / 1000]), [["human", undefined, "ask", 198], ["peer", "01a20d4d-548e", "idle", 340], ["ci", undefined, "idle", 290]]);
	assert.equal(w.idleSince, "2026-11-25T10:15:10.000Z", "the last turn ended and nothing woke it");
});

test("a subagent's own todo list is nested under its parent's item", () => {
	const reader = new SessionReader("/s/--x--/2026-11-25T10-00-00-000Z_11111111-2222-4333-8444-555555555555-0a5f8613-374f083b-30bc.jsonl", HOME);
	const spec = { id: SID, cwd: `${HOME}/projects/demo-repo`, start: "2026-11-25T10:00:00.000Z", entries: (t: (s: number) => string) => [user(t(0), `Read /home/tester/.pi/agent/sessions/x/artifacts/01a2cccc-0000-7000-8000-000000000000/context/a-build-2026-11-25T10-00-00.md`), todo(t(1), [task(1, "in_progress")])] };
	for (const line of sessionLines(spec).split("\n")) reader.feedLine(line);
	const { summary } = reader.finish();
	assert.equal(summary.childName, "a-build");
	assert.equal(summary.work?.items[0].level, "nested");
});

test("titles are one line of at most 80 characters", () => {
	assert.equal(titleOf("  a\nb\t c  "), "a b c");
	const long = "字".repeat(100);
	assert.equal(Array.from(titleOf(long)).length, 80);
	assert.equal(titleOf(undefined), "");
});
