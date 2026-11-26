import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "../src/aggregate.ts";
import { SessionReader } from "../src/extract/session.ts";
import { setKnownProjects } from "../src/project.ts";
import { joinWork, workRecords } from "../src/work/join.ts";
import { assistant, call, customMessage, result, type SessionSpec, sessionLines, stop, todo, user } from "./fixtures.ts";

const HOME = "/home/tester";
setKnownProjects(["demo-repo"]);
const MAIN = "01a20000-0000-7000-8000-0000000000b1";
const A = "aaaaaaaa-1111-4111-8111-111111111111";
const B = "bbbbbbbb-2222-4222-8222-222222222222";
const C = "cccccccc-3333-4333-8333-333333333333";
const START = "2026-11-25T10:00:00.000Z";
const t = (s: number) => new Date(Date.parse(START) + s * 1000).toISOString();

function summarize(path: string, spec: SessionSpec): SessionSummary {
	const reader = new SessionReader(path, HOME);
	for (const line of sessionLines(spec).split("\n")) reader.feedLine(line);
	return reader.finish().summary;
}
const brief = (name: string) => user(t(0), `Read ${HOME}/.pi/agent/sessions/x/artifacts/${MAIN}/context/${name}-2026-11-25T10-00-00.md`);
const child = (id: string, name: string, cost: number) =>
	summarize(`/s/--c--/2026-11-25T10-00-00-000Z_${id}-0a5f8613-374f083b-30bc.jsonl`, { id: `${id.slice(0, 8)}-0000-7000-8000-000000000000`, cwd: `${HOME}/projects/demo-repo`, start: START, entries: () => [brief(name), assistant(t(5), [], cost)] });
const launch = (callId: string, id: string, name: string, agent: string, s: number, item?: string) => [
	assistant(t(s), [call(callId, "subagent", { agent, task: "x" })]),
	result(t(s + 1), callId, "subagent", { details: { id, name, agent, model: "openai-codex/gpt-6.2-astra", ...(item ? { item } : {}) } }),
];
const task = (id: number, subject: string, status: string, more: Record<string, unknown> = {}) => ({ id, subject, status, ...more });

function sbDir(threads: Record<string, { meta: Record<string, unknown>; posts: Record<string, unknown>[] }>, cars: Record<string, unknown>[] = [], ledger: Record<string, unknown>[] = []) {
	const dir = mkdtempSync(join(tmpdir(), "pi-evals-sb-"));
	const tdir = join(dir, "threads", MAIN.slice(0, 8));
	mkdirSync(tdir, { recursive: true });
	for (const [id, th] of Object.entries(threads)) {
		writeFileSync(join(tdir, `${id}.json`), JSON.stringify({ version: 1, id, owner: MAIN, rounds: 3, ...th.meta }));
		writeFileSync(join(tdir, `${id}.jsonl`), th.posts.map((p) => JSON.stringify(p)).join("\n"));
	}
	mkdirSync(join(dir, "trainboard", "demo", "cars"), { recursive: true });
	cars.forEach((c, i) => writeFileSync(join(dir, "trainboard", "demo", "cars", `app-${i}.json`), JSON.stringify(c)));
	if (ledger.length) {
		mkdirSync(join(dir, "ledger"), { recursive: true });
		writeFileSync(join(dir, "ledger", "2026-11-25.jsonl"), ledger.map((l) => JSON.stringify(l)).join("\n"));
	}
	return dir;
}

function mainSession(extra: (s: number) => Record<string, unknown>[] = () => []) {
	return summarize(`/s/--m--/2026-11-25T10-00-00-000Z_${MAIN}.jsonl`, {
		id: MAIN,
		cwd: `${HOME}/projects/demo-repo`,
		start: START,
		entries: () => [
			user(t(0), "go"),
			todo(t(10), [task(1, "Build A", "in_progress", { owner: "a-build" }), task(2, "Ship MP-42 car", "pending"), task(3, "Tidy notes", "pending"), task(4, "Dropped", "pending")]),
			...launch("l1", A, "a-build", "worker", 20),
			...launch("l2", B, "a-review", "reviewer", 30),
			assistant(t(40), [], 2),
			stop(t(50)),
			customMessage(t(400), "subagent_result", "done", { name: "a-build" }),
			todo(t(600), [task(1, "Build A", "completed", { owner: "a-build", evidence: [{ command: "npm test", result: "pass", at: t(600) }] }), task(2, "Ship MP-42 car", "in_progress"), task(3, "Tidy notes", "pending"), task(4, "Dropped", "pending")]),
			...launch("l3", C, "helper", "scout", 610, "t_shipcar001"),
			todo(t(700), [task(1, "Build A", "completed", { owner: "a-build", evidence: [{ command: "npm test", result: "pass", at: t(600) }] }), task(2, "Ship MP-42 car", "completed", { uid: "t_shipcar001" }), task(3, "Tidy notes", "in_progress"), task(4, "Dropped", "deleted")]),
			todo(t(800), [task(1, "Build A", "completed", { owner: "a-build", evidence: [{ command: "npm test", result: "pass", at: t(600) }] }), task(2, "Ship MP-42 car", "completed", { uid: "t_shipcar001" }), task(3, "Tidy notes", "completed", { evidence: [{ command: "ls", result: "pass", at: t(800) }] }), task(4, "Dropped", "deleted"), task(5, "Still going", "in_progress", { owner: "e-build" })]),
			...launch("l4", "eeeeeeee-5555-4555-8555-555555555555", "e-build", "worker", 810),
			...extra(820),
			stop(t(900)),
		],
	});
}

const join_ = (summaries: SessionSummary[], dir: string) => joinWork({ summaries, changes: [], sbDir: dir, repos: [], now: new Date(t(5000)) });
const byTitle = (file: ReturnType<typeof join_>) => Object.fromEntries(file.items.map((i) => [i.title, i]));

test("without producer fields: children join by owner name and reviewer prefix, close kinds come from thread, car and evidence", () => {
	const dir = sbDir(
		{ T1: { meta: { worker: "a-build", reviewer: "a-review", created: Date.parse(t(20)) }, posts: [{ n: 1, at: Date.parse(t(300)), from: "worker", tag: "review" }, { n: 2, at: Date.parse(t(590)), from: "reviewer", tag: "done" }] } },
		[{ coordinator: MAIN, car: { tickets: ["MP-42"] }, states: [{ state: "received", at: t(620) }, { state: "landed", at: t(690) }] }],
	);
	const file = join_([mainSession(), child(A, "a-build", 3), child(B, "a-review", 1), child(C, "helper", 0.5)], dir);
	const items = byTitle(file);
	assert.equal(items["Build A"].childCost, 4, "worker and reviewer, exact");
	assert.deepEqual(items["Build A"].children, ["a-build", "a-review"]);
	assert.equal(items["Build A"].kind, "delegated");
	assert.equal(items["Build A"].role, "worker");
	assert.equal(items["Build A"].closeKind, "review_done");
	assert.equal(items["Build A"].thread, "T1");
	assert.equal(items["Build A"].closeAt, t(590));
	assert.equal(items["Build A"].mainCost, 2.02, "its two launch replies and one reply alone");
	assert.deepEqual(items["Build A"].stallMs, { child: 350_000 });
	assert.equal(items["Ship MP-42 car"].closeKind, "landed");
	assert.equal(items["Ship MP-42 car"].key, "t_shipcar001");
	assert.equal(items["Ship MP-42 car"].childCost, 0.5, "launch item = the task uid");
	assert.equal(items["Tidy notes"].closeKind, "evidence");
	assert.equal(items["Tidy notes"].kind, "self");
	assert.equal(items.Dropped.closeKind, "deleted");
	const open = items["Still going"];
	assert.equal(open.closeKind, "open");
	assert.deepEqual(open.open, { since: t(900), kind: "child", on: "e-build" }, "launched, no result yet");
	const records = workRecords(file);
	assert.equal(records.filter((r) => r.name === "pi.workitem").length, 5);
	const stall = records.find((r) => r.name === "pi.stall");
	assert.equal(stall?.attrs["pi.stall.kind"], "child");
	assert.equal(stall?.attrs["pi.stall.on"], "a-build");
});

test("with producer fields: thread item and closed, and the sb ledger names the wait", () => {
	const dir = sbDir(
		{ T7: { meta: { worker: "someone-else", reviewer: "x-review", item: `${MAIN.slice(0, 8)}#3`, closed: Date.parse(t(790)) }, posts: [{ n: 1, at: Date.parse(t(750)), from: "worker", tag: "review" }] } },
		[],
		[
			{ v: 1, at: Date.parse(t(60)), kind: "wait_raised", id: "W12", session: MAIN, workspace: "w1" },
			{ v: 1, at: Date.parse(t(399)), kind: "thread_close", id: "T1", session: MAIN, workspace: "w1", why: "done" },
			{ v: 1, at: Date.parse(t(850)), kind: "link_wait_open", id: "L340", session: MAIN, workspace: "w1" },
		],
	);
	const file = join_([mainSession(), child(A, "a-build", 3)], dir);
	const items = byTitle(file);
	assert.equal(items["Tidy notes"].closeKind, "review_done", "thread.item names the task, closed set by sb");
	assert.equal(items["Tidy notes"].thread, "T7");
	assert.deepEqual(items["Build A"].stalls.map((s) => [s.kind, s.on]), [["child", "T1"]], "ledger names the thread");
	assert.equal(items["Build A"].closeKind, "evidence", "no thread for its owner here");
});

test("an open item waits on an open ledger wait when no child is running", () => {
	const dir = sbDir({}, [], [{ v: 1, at: Date.parse(t(850)), kind: "link_wait_open", id: "L340", session: MAIN, workspace: "w1" }]);
	const s = mainSession((at) => [customMessage(t(at), "subagent_result", "done", { name: "e-build" })]);
	const items = byTitle(join_([s], dir));
	assert.deepEqual(items["Still going"].open, { since: t(900), kind: "device", on: "L340" });
});

test("the comparison says plainly when there are too few items, and compares only like with like", async () => {
	const { workModel } = await import("../src/work/model.ts");
	const { verdictText } = await import("../src/report/work.ts");
	const item = (i: number, model: string, cost: number, kind: "delegated" | "self" = "delegated") => ({
		key: `s#${i}`, title: `T${i}`, project: "p", session: "s", sessions: ["s"], level: "top" as const, status: "completed" as const, created: t(i), start: t(i), close: t(i + 1), activeMs: 60_000,
		closeKind: "evidence" as const, evidence: 1, blockedBy: 0, mainCost: 0, childCost: cost, children: kind === "delegated" ? ["w"] : [], kind, role: "worker", model, stalls: [], stallMs: {}, lastActivity: t(i + 1),
	});
	const few = [item(1, "a", 1), item(2, "a", 1), item(3, "b", 5), item(4, "b", 5), item(5, "self-model", 9, "self")];
	const m = workModel({ v: 1, built: t(100), items: few, sessions: [] }, {});
	const byModel = m!.compare.find((c) => c.kind === "delegated" && c.dimension === "model")!;
	assert.equal(byModel.verdict.kind, "few");
	assert.match(verdictText(byModel, byModel.verdict, (_en, zh) => zh), /^件數太少，還看不出來/);
	assert.ok(!byModel.groups.some((g) => g.value === "self-model"), "self items are compared only with self items");
	const many = [...Array(6).keys()].flatMap((i) => [item(10 + i, "a", 1), item(20 + i, "b", 4)]);
	const enough = workModel({ v: 1, built: t(100), items: many, sessions: [] }, {})!.compare.find((c) => c.dimension === "model")!;
	assert.deepEqual(enough.verdict, { kind: "cheaper", a: "a", b: "b", by: 0.75 });
});
