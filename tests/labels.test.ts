import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createEvals } from "../src/index.ts";
import { readLabels } from "../src/labels.ts";
import { setKnownProjects } from "../src/project.ts";
import { todo } from "./fixtures.ts";

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
	let branch: unknown[] = [];
	const clock = { t: Date.parse("2026-11-26T06:00:00.000Z") };
	const pi = {
		on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
		events: { on: () => () => {}, emit: () => {} },
		registerTool: (t: ToolDefinition) => tools.set(t.name, t),
		registerCommand: (_name: string, c: typeof command) => (command = c),
		getAllTools: () => [],
	} as unknown as ExtensionAPI;
	createEvals({ env, now: () => clock.t })(pi);
	const ctx = {
		hasUI: true,
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
		home, env, state, notes, asked, answers, clock, ctx, fire, labelsFile,
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
	// A wrong rule or verdict writes nothing and says how to use it.
	await h.run("label nope fail");
	await h.run("label todo_evidence maybe");
	assert.equal(h.raw().length, 3);
	assert.match(h.notes.at(-1)!, /\/evals label/);
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
