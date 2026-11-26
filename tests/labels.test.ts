import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { emptyDay, type SessionRow } from "../src/aggregate.ts";
import type { DaysIndex } from "../src/build.ts";
import type { Change } from "../src/changes.ts";
import { findings } from "../src/findings.ts";
import { createEvals } from "../src/index.ts";
import { labelsView } from "../src/labels-query.ts";
import { readLabels } from "../src/labels.ts";
import { buildModel } from "../src/model.ts";
import { renderHtml } from "../src/render.ts";
import { setKnownProjects } from "../src/project.ts";
import { query, VIEWS } from "../src/query.ts";
import { model, runExtract } from "../src/ops.ts";
import { traceId } from "../src/schema.ts";
import { richSession, SECRET, todo, writeAgentDir } from "./fixtures.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** The extension with a fake pi: one session, a branch the test can set, and scripted dialog answers. */
function setup(session = "01a2aaaa-0000-7000-8000-000000000001", sharedState?: string) {
	const home = mkdtempSync(join(tmpdir(), "pi-evals-labels-"));
	setKnownProjects(["demo-repo"]);
	const state = sharedState ?? join(home, "state");
	const env = { HOME: home, PI_CODING_AGENT_DIR: join(home, "agent"), PI_EVALS_STATE_DIR: state, XDG_CONFIG_HOME: join(home, "config") };
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, ToolDefinition>();
	let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
	const notes: string[] = [];
	const answers: (string | undefined)[] = [];
	const asked: { kind: string; title: string; options?: string[] }[] = [];
	const sent: { text: string; options?: unknown }[] = [];
	let branch: unknown[] = [];
	const clock = { t: Date.parse("2026-11-26T06:00:00.000Z") };
	const pi = {
		on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
		events: { on: () => () => {}, emit: () => {} },
		registerTool: (t: ToolDefinition) => tools.set(t.name, t),
		registerCommand: (_name: string, c: typeof command) => (command = c),
		getAllTools: () => [],
		sendUserMessage: (text: string, options?: unknown) => sent.push({ text, options }),
	} as unknown as ExtensionAPI;
	createEvals({ env, now: () => clock.t })(pi);
	const ctx = {
		hasUI: true,
		isIdle: () => true,
		cwd: join(home, "projects", "demo-repo"),
		ui: {
			notify: (text: string) => notes.push(text),
			setStatus: () => {},
			select: async (title: string, options: string[]) => (asked.push({ kind: "select", title, options }), answers.shift()),
			input: async (title: string) => (asked.push({ kind: "input", title }), answers.shift()),
		},
		sessionManager: { getSessionId: () => session, getSessionFile: () => undefined, getBranch: () => branch },
	};
	const fire = async (name: string, event: unknown = {}) => {
		for (const h of handlers.get(name) ?? []) await h(event, ctx);
	};
	const labelsFile = join(state, "labels.jsonl");
	return {
		home, env, state, notes, asked, answers, sent, clock, ctx, fire, labelsFile,
		setBranch: (b: unknown[]) => (branch = b),
		run: (args: string) => command!.handler(args, ctx),
		tool: (name: string) => tools.get(name)!,
		raw: () => (existsSync(labelsFile) ? readFileSync(labelsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
	};
}

test("/evals label with arguments records a live human row with the in-progress item key", async () => {
	const h = setup();
	await h.fire("session_start");
	h.setBranch([todo("2026-11-26T05:00:00.000Z", [{ id: 1, subject: "done one", status: "completed" }, { id: 3, subject: "fix", status: "in_progress", uid: "MP-1234" }])]);
	await h.run("label check_after_last_edit fail 他沒跑測試就說好了");
	const [row] = h.raw();
	assert.deepEqual(row, {
		session_id: "01a2aaaa-0000-7000-8000-000000000001",
		evaluation_name: "check_after_last_edit",
		label: "fail",
		at: "2026-11-26T06:00:00.000Z",
		annotator: "human",
		source: "live",
		item: "MP-1234",
		project: "demo-repo",
		note: "他沒跑測試就說好了",
	});
	assert.equal(h.notes.length, 1);
	assert.doesNotMatch(h.notes[0], /\n/, "one line");
	assert.match(h.notes[0], /最後一次修改後有跑檢查/);
	assert.match(h.notes[0], /沒照做/);
	// Without a uid the key is <session>#<id>; with nothing in progress there is no item.
	h.setBranch([todo("2026-11-26T05:00:00.000Z", [{ id: 2, subject: "x", status: "in_progress" }])]);
	await h.run("label other unclear");
	assert.equal(h.raw()[1].item, "01a2aaaa-0000-7000-8000-000000000001#2");
	assert.equal(h.raw()[1].note, undefined);
	h.setBranch([]);
	await h.run("label todo_evidence pass");
	assert.equal(h.raw()[2].item, undefined);
	// Anything else is the user's own words for the agent to format; the command itself writes nothing.
	await h.run("label todo_evidence maybe");
	assert.equal(h.raw().length, 3);
	assert.equal(h.sent.length, 1);
});

test("/evals label without arguments asks for the rule, the verdict and an optional note in plain words", async () => {
	const h = setup();
	await h.fire("session_start");
	h.answers.push("動手前先說好怎麼驗證", "沒照做", "先改檔才說要測");
	await h.run("label");
	assert.deepEqual(h.asked.map((a) => a.kind), ["select", "select", "input"]);
	assert.deepEqual(h.asked[0].options, ["動手前先說好怎麼驗證", "最後一次修改後有跑檢查", "完成的待辦附有證據", "收尾時不需要提醒", "其他"]);
	assert.deepEqual(h.asked[1].options, ["照做", "沒照做", "看不出來"]);
	const [row] = h.raw();
	assert.equal(row.evaluation_name, "anchor_before_first_edit");
	assert.equal(row.label, "fail");
	assert.equal(row.note, "先改檔才說要測");
	assert.equal(row.source, "live");
	// An empty note stores none; cancelling a step records nothing.
	h.answers.push("其他", "照做", "");
	await h.run("label");
	assert.equal(h.raw()[1].evaluation_name, "other");
	assert.equal(h.raw()[1].note, undefined);
	h.answers.push("其他", undefined);
	await h.run("label");
	assert.equal(h.raw().length, 2);
	assert.match(h.notes.at(-1)!, /取消/);
});

test("/evals label undo withdraws only this session's last live label", async () => {
	const h = setup();
	await h.fire("session_start");
	await h.run("label todo_evidence pass");
	await h.run("label todo_evidence fail");
	const other = setup("01a2bbbb-0000-7000-8000-000000000002", h.state);
	await other.fire("session_start");
	await other.run("label other fail");
	await h.run("label undo");
	let left = readLabels(h.labelsFile);
	assert.deepEqual(left.map((r) => `${r.evaluation_name} ${r.label}`), ["todo_evidence pass", "other fail"]);
	assert.match(h.notes.at(-1)!, /撤銷/);
	await h.run("label undo");
	await h.run("label undo");
	left = readLabels(h.labelsFile);
	assert.deepEqual(left.map((r) => r.session_id), ["01a2bbbb-0000-7000-8000-000000000002"]);
	assert.match(h.notes.at(-1)!, /沒有/);
	// A batch label of this session is not a live one and stays.
	const batch = setup();
	await batch.fire("session_start");
	const { appendFileSync, mkdirSync } = await import("node:fs");
	mkdirSync(batch.state, { recursive: true });
	appendFileSync(batch.labelsFile, `${JSON.stringify({ session_id: "01a2aaaa-0000-7000-8000-000000000001", evaluation_name: "todo_evidence", label: "pass", at: "2026-11-26T05:51:51.220Z", annotator: "human" })}\n`);
	await batch.run("label undo");
	assert.equal(readLabels(batch.labelsFile).length, 1);
});

test("a human note is the only free text kept, on one bounded line", async () => {
	const h = setup();
	await h.fire("session_start");
	await h.run(`label other fail ${"字".repeat(600)}`);
	assert.equal(Array.from(h.raw()[0].note as string).length, 500);
	h.answers.push("其他", "沒照做", "第一行\n第二行");
	await h.run("label");
	assert.equal(h.raw()[1].note, "第一行 第二行");
});

test("evals_label records an agent correction with names only and rejects free text", async () => {
	const h = setup();
	await h.fire("session_start");
	await h.fire("input", { text: "/skill:coding" });
	h.setBranch([todo("2026-11-26T05:00:00.000Z", [{ id: 4, subject: "fix", status: "in_progress" }])]);
	const tool = h.tool("evals_label");
	const exec = (params: Record<string, unknown>) => tool.execute("id", params as never, undefined, undefined, h.ctx as never);
	const out = await exec({ rule: "check_after_last_edit", type: "no_check_run" });
	assert.match((out.content[0] as { text: string }).text, /check_after_last_edit/);
	await exec({ rule: "other" });
	assert.deepEqual(h.raw(), [
		{ session_id: "01a2aaaa-0000-7000-8000-000000000001", evaluation_name: "check_after_last_edit", label: "fail", at: "2026-11-26T06:00:00.000Z", annotator: "agent", source: "correction", type: "no_check_run", item: "01a2aaaa-0000-7000-8000-000000000001#4", project: "demo-repo", skills: ["coding"] },
		{ session_id: "01a2aaaa-0000-7000-8000-000000000001", evaluation_name: "other", label: "fail", at: "2026-11-26T06:00:00.000Z", annotator: "agent", source: "correction", item: "01a2aaaa-0000-7000-8000-000000000001#4", project: "demo-repo", skills: ["coding"] },
	]);
	// A planted string in any field, or any other field, is refused and writes nothing.
	await assert.rejects(exec({ rule: SECRET }), /rule must be/);
	await assert.rejects(exec({ rule: "other", type: SECRET }), /type must be/);
	await assert.rejects(exec({ rule: "other", note: SECRET }), /only rule, label, type and on_behalf/);
	await assert.rejects(exec({ rule: "other", label: "pass" }), /always a fail/);
	await assert.rejects(exec({ rule: "other", on_behalf: SECRET }), /on_behalf/);
	assert.equal(h.raw().length, 2);
	assert.ok(!readFileSync(h.labelsFile, "utf8").includes("PLANTED"));
	// Small on purpose: every session pays for the tool's text.
	const text = tool.description + (tool.promptSnippet ?? "") + JSON.stringify(tool.parameters);
	assert.ok(tool.description.length <= 200, `description ${tool.description.length}`);
	assert.ok(Buffer.byteLength(text) < 720, `tool text ${Buffer.byteLength(text)} bytes`);
});

/** A one-day index whose sessions s1..s3 are indexed (hashed ids), plus code verdicts for them. */
function labelled(rows: Record<string, unknown>[], filter: { since?: string; until?: string; project?: string } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-evals-lm-"));
	const labels = join(dir, "labels.jsonl");
	const evals = join(dir, "session-evals.json");
	writeFileSync(evals, JSON.stringify({ s1: { anchor_before_first_edit: "pass", check_after_last_edit: "fail" }, s2: { anchor_before_first_edit: "fail" }, s3: { anchor_before_first_edit: "pass" } }));
	writeFileSync(labels, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
	const agg = emptyDay();
	agg.sessions = 3;
	const idx: DaysIndex = { v: 1, built: "2026-11-26T00:00:00.000Z", lastExtract: "2026-11-26T00:00:00.000Z", days: { "2026-11-24": { p: agg } }, owners: {}, offeredSkills: [], sessions: { backfill: 3, live: 0, both: 0, subagent: 0, linked: 0 }, range: { start: "2026-11-24T12:00:00.000Z", end: "2026-11-26T00:00:00.000Z" } };
	const sessionRows: SessionRow[] = ["s1", "s2", "s3"].map((id) => ({ id: traceId(id, "labels"), s: "2026-11-24T12:00:00.000Z", p: "p", k: 0, c: 0, t: {}, ac: 0, ax: 0, sl: 0, nt: 0, ev: {} }));
	const changes: Change[] = [{ at: "2026-11-25T00:00:00.000Z", kind: "pin", subject: "pin", package: "pi-anchorloop", from: "3.2.0", to: "3.3.0", source: "git", sha: "a" }];
	return buildModel({ index: idx, rows: sessionRows, changes, filter, windowDays: 3, labelsFile: labels, sessionEvalsFile: evals, now: new Date("2026-11-26T06:00:00.000Z") });
}

const human = (s: string, rule: string, label: string, extra: Record<string, unknown> = {}) => ({ session_id: s, evaluation_name: rule, label, at: "2026-11-26T05:51:51.220Z", annotator: "human", ...extra });
const agent = (s: string, rule: string, extra: Record<string, unknown> = {}) => ({ session_id: s, evaluation_name: rule, label: "fail", at: "2026-11-26T05:00:00.000Z", annotator: "agent", source: "correction", project: "p", ...extra });

test("agreement counts human labels only, given after the fact or in the moment, and splits them by when", () => {
	const m = labelled([
		human("s1", "anchor_before_first_edit", "pass"),
		human("s2", "anchor_before_first_edit", "pass"),
		human("s3", "anchor_before_first_edit", "pass", { source: "live" }),
		human("s1", "check_after_last_edit", "fail", { source: "live" }),
		human("s1", "other", "fail", { source: "live", note: "自己的話" }),
		human("live-only", "anchor_before_first_edit", "fail", { source: "live", project: "p" }),
		agent("s1", "anchor_before_first_edit"),
		agent("s2", "anchor_before_first_edit"),
	]);
	const a = m.labels.agreement.find((r) => r.detector === "anchor_before_first_edit")!;
	assert.deepEqual([a.n, a.agree], [3, 2], "agent rows are not verdicts on the code");
	assert.deepEqual([a.bySource.batch.n, a.bySource.batch.agree, a.bySource.live.n, a.bySource.live.agree], [2, 1, 1, 1]);
	assert.deepEqual(m.labels.bySource, { batch: 2, live: 4 });
	assert.deepEqual(m.labels.sessions, { batch: 2, live: 3 });
	assert.equal(m.labels.other, 1);
	assert.equal(m.labels.noCode, 1, "a live label on a session not extracted yet waits for its code verdict");
	assert.equal(m.labels.n, 6);
});

test("a live label of a session not extracted yet is placed in range by its own time and project", () => {
	const rows = [human("live-only", "todo_evidence", "pass", { source: "live", project: "p" }), agent("live-only", "other", { at: "2026-11-20T00:00:00.000Z" })];
	assert.equal(labelled(rows, { since: "2026-11-24", until: "2026-11-26" }).labels.n, 1);
	assert.equal(labelled(rows, { since: "2026-11-24", until: "2026-11-26" }).labels.corrections.n, 0, "a correction outside the dates stays out");
	assert.equal(labelled(rows, { since: "2026-11-24", until: "2026-11-26", project: "q" }).labels.n, 0);
	// An indexed session outside the range keeps its labels out, whatever their time.
	assert.equal(labelled([human("s1", "todo_evidence", "pass", { source: "live" })], { since: "2026-11-25" }).labels.n, 0);
});

test("corrections count by rule, failure type, skill loaded and anchorloop version", () => {
	const m = labelled([
		agent("s1", "check_after_last_edit", { type: "no_check_run", skills: ["coding", "inspecting"] }),
		agent("s1", "check_after_last_edit", { type: "no_check_run", skills: ["coding"], at: "2026-11-25T06:00:00.000Z" }),
		agent("s2", "other", { type: "ignored_instruction" }),
		human("s1", "check_after_last_edit", "fail", { source: "live" }),
	]);
	const c = m.labels.corrections;
	assert.equal(c.n, 3);
	assert.equal(c.sessions, 2);
	assert.deepEqual(c.byRule, [{ rule: "check_after_last_edit", n: 2 }, { rule: "other", n: 1 }]);
	assert.deepEqual(c.byType, [{ type: "no_check_run", n: 2 }, { type: "ignored_instruction", n: 1 }]);
	assert.deepEqual(c.byRuleType[0], { rule: "check_after_last_edit", type: "no_check_run", n: 2 });
	assert.deepEqual(c.bySkill, [{ skill: "coding", n: 2, sessions: 1 }, { skill: "", n: 1, sessions: 1 }, { skill: "inspecting", n: 1, sessions: 1 }]);
	assert.deepEqual(c.byVersion, [{ version: "3.3.0", n: 3, sessions: 2 }]);
});

test("the report splits your labels by when they were given, explains it, and shows corrections with their limits", () => {
	const m = labelled([
		human("s1", "anchor_before_first_edit", "pass"),
		human("s2", "anchor_before_first_edit", "pass"),
		human("s3", "anchor_before_first_edit", "pass", { source: "live", note: "只有我看得到的話" }),
		agent("s1", "check_after_last_edit", { type: "no_check_run", skills: ["coding"] }),
	]);
	const html = renderHtml(m, "zh");
	assert.match(html, /事後標 2 筆（2 段工作）　／　當下標 1 筆（1 段工作）/);
	assert.match(html, /當下標記 vs 事後標記/);
	assert.match(html, /目前事後標了 2 段工作，程式和你一致的有：「動手前先說好怎麼驗證」1\/2。/);
	assert.match(html, /id="corrections"/);
	assert.match(html, /不是所有錯誤/);
	assert.match(html, /只有 1 次，太少/);
	assert.match(html, /沒跑檢查/);
	assert.match(html, /coding/);
	assert.match(html, /3\.3\.0/);
	assert.ok(!html.includes("只有我看得到的話"), "a note stays in the labels file");
	assert.match(renderHtml(m, "en"), /Times the agent was corrected/);
});

test("the labels view and a findings line give names and numbers, never a note", () => {
	const rows = [
		human("s1", "anchor_before_first_edit", "pass", { note: SECRET }),
		human("s3", "anchor_before_first_edit", "pass", { source: "live", note: SECRET }),
		...[1, 2, 3].map((i) => agent("s1", "check_after_last_edit", { type: "no_check_run", at: `2026-11-26T0${i}:00:00.000Z` })),
		agent("s2", "other"),
	];
	const m = labelled(rows);
	const view = labelsView(m).join("\n");
	assert.match(view, /after the fact 1 \(1 sessions\), in the moment 1 \(1 sessions\)/);
	assert.match(view, /anchor_before_first_edit: 2\/2 \(1\/1; 1\/1\)/);
	assert.match(view, /4 in 2 sessions; small/);
	assert.match(view, /by rule\/type: check_after_last_edit\/no_check_run 3, other\/other 1/);
	assert.ok(!view.includes("PLANTED"));
	assert.match(findings(m), /Corrections logged: 3 of 4 are check_after_last_edit\/no_check_run .*→ labels/);
	assert.doesNotMatch(findings(labelled(rows.slice(0, 4))), /Corrections logged/, "two of a kind is not a cluster");
	assert.ok(VIEWS.includes("labels"));
});

test("/evals label <your words> has the agent format them into labels for you, only during that turn", async () => {
	const h = setup();
	await h.fire("session_start");
	const words = "剛剛沒先跑測試就說完成";
	await h.run(`label ${words}`);
	assert.equal(h.raw().length, 0, "the command writes nothing itself");
	assert.equal(h.sent.length, 1);
	const prompt = h.sent[0].text;
	assert.ok(prompt.includes(words));
	assert.match(prompt, /evals_label/);
	assert.match(prompt, /on_behalf/);
	assert.match(h.notes.at(-1)!, /交給代理人/);
	const tool = h.tool("evals_label");
	const exec = (params: Record<string, unknown>) => tool.execute("id", params as never, undefined, undefined, h.ctx as never);
	// Before the turn starts there is nothing to speak for.
	await assert.rejects(exec({ rule: "check_after_last_edit", label: "fail", on_behalf: "user" }), /on_behalf/);
	await h.fire("before_agent_start", { messageType: "user", prompt });
	await exec({ rule: "check_after_last_edit", label: "fail", type: "unverified_claim", on_behalf: "user" });
	await exec({ rule: "anchor_before_first_edit", label: "unclear", on_behalf: "user" });
	await assert.rejects(exec({ rule: "other", label: "fail", on_behalf: "user", note: "agent text" }), /only rule, label, type and on_behalf/);
	await assert.rejects(exec({ rule: "other", label: "maybe", on_behalf: "user" }), /label must be/);
	await assert.rejects(exec({ rule: "other", on_behalf: "user" }), /label must be/);
	await assert.rejects(exec({ rule: "other", label: "pass", type: "wrong_order", on_behalf: "user" }), /type .*fail/);
	// The user's own prompt message keeps the turn open; another message from the user closes it.
	await h.fire("message_end", { message: { role: "user", content: [{ type: "text", text: prompt }] } });
	await exec({ rule: "todo_evidence", label: "pass", on_behalf: "user" });
	await h.fire("message_end", { message: { role: "user", content: [{ type: "text", text: "something else" }] } });
	await assert.rejects(exec({ rule: "todo_evidence", label: "pass", on_behalf: "user" }), /on_behalf/);
	await h.fire("agent_end", {});
	assert.deepEqual(h.raw(), [
		{ session_id: "01a2aaaa-0000-7000-8000-000000000001", evaluation_name: "check_after_last_edit", label: "fail", at: "2026-11-26T06:00:00.000Z", annotator: "human", source: "live-prompt", type: "unverified_claim", project: "demo-repo", note: words },
		{ session_id: "01a2aaaa-0000-7000-8000-000000000001", evaluation_name: "anchor_before_first_edit", label: "unclear", at: "2026-11-26T06:00:00.000Z", annotator: "human", source: "live-prompt", project: "demo-repo", note: words },
		{ session_id: "01a2aaaa-0000-7000-8000-000000000001", evaluation_name: "todo_evidence", label: "pass", at: "2026-11-26T06:00:00.000Z", annotator: "human", source: "live-prompt", project: "demo-repo", note: words },
	]);
	// After the turn the same call cannot claim to be the user's, and an agent's own label is a fail only.
	await assert.rejects(exec({ rule: "check_after_last_edit", label: "fail", on_behalf: "user" }), /on_behalf/);
	await assert.rejects(exec({ rule: "check_after_last_edit", label: "pass" }), /fail/);
	await assert.rejects(exec({ rule: "other", on_behalf: "agent" }), /on_behalf/);
	await exec({ rule: "check_after_last_edit", label: "fail" });
	assert.equal(h.raw().at(-1).annotator, "agent");
	assert.equal(h.raw().length, 4);
	// A message from another session's command does not open this one.
	const other = setup("01a2bbbb-0000-7000-8000-000000000002", h.state);
	await other.fire("session_start");
	await other.fire("before_agent_start", { messageType: "user", prompt: "unrelated" });
	await assert.rejects(other.tool("evals_label").execute("id", { rule: "other", label: "fail", on_behalf: "user" } as never, undefined, undefined, other.ctx as never), /on_behalf/);
	// The rows count as labels given in the moment, and undo withdraws them like any live label.
	await h.run("label undo");
	assert.deepEqual(readLabels(h.labelsFile).map((r) => r.evaluation_name), ["check_after_last_edit", "anchor_before_first_edit", "check_after_last_edit"]);
});

test("a label written for you by the agent counts as given in the moment", () => {
	const m = labelled([human("s1", "anchor_before_first_edit", "pass", { source: "live-prompt", note: "x" })]);
	assert.deepEqual(m.labels.bySource, { batch: 0, live: 1 });
	assert.equal(m.labels.fromWords, 1, "shown apart: the agent picked rule and verdict from the user's words");
	assert.equal(m.labels.agreement[0].bySource.live.agree, 1);
	assert.match(renderHtml(m, "zh"), /其中 1 筆是代理人依你的話整理的/);
	assert.match(labelsView(m).join("\n"), /1 formatted by the agent from your words/);
});

test("a label given on a day after the last extract shows in the default report range and query", async () => {
	const home = mkdtempSync(join(tmpdir(), "pi-evals-after-"));
	setKnownProjects(["demo-repo"]);
	const agentDir = writeAgentDir([{ dir: "--demo--", file: "2026-11-24T10-00-00-000Z_01a20000-0000-7000-8000-000000000001.jsonl", spec: richSession(home) }]);
	const env = { HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_EVALS_STATE_DIR: join(home, "state"), XDG_CONFIG_HOME: join(home, "config") };
	const status = await runExtract({ env, workers: 0 });
	const later = new Date(Date.parse(status.lastExtract) + 86_400_000).toISOString();
	const file = join(home, "state", "labels.jsonl");
	writeFileSync(file, [human("not-indexed", "todo_evidence", "pass", { source: "live", at: later }), agent("not-indexed", "other", { at: later })].map((r) => JSON.stringify(r)).join("\n") + "\n");
	const view = query("labels", { env });
	assert.match(view, /in the moment 1 \(1 sessions/);
	assert.match(view, /corrections the agent logged \(not all mistakes\): 1 in 1 sessions/);
	assert.equal(model({}, env)?.labels.n, 1);
	// A range the user ends on purpose still ends there.
	assert.equal(model({ until: status.lastExtract.slice(0, 10) }, env)?.labels.n, 0);
});
