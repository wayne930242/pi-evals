import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { emptyDay, type SessionRow } from "../src/aggregate.ts";
import { ASK_AI_BLOCKED, askPrompt } from "../src/ask-ai.ts";
import type { DaysIndex } from "../src/build.ts";
import { createEvals } from "../src/index.ts";
import { buildModel } from "../src/model.ts";
import { setKnownProjects } from "../src/project.ts";
import { renderHtml } from "../src/render.ts";
import { traceId } from "../src/schema.ts";
import { todo } from "./fixtures.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
const SESSION = "01a2aaaa-0000-7000-8000-000000000001";

function setup() {
	const home = mkdtempSync(join(tmpdir(), "pi-evals-ask-"));
	setKnownProjects(["demo-repo"]);
	const state = join(home, "state");
	const env = { HOME: home, PI_CODING_AGENT_DIR: join(home, "agent"), PI_EVALS_STATE_DIR: state, XDG_CONFIG_HOME: join(home, "config") };
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const notes: string[] = [];
	const sent: { text: string; options?: unknown }[] = [];
	let branch: unknown[] = [];
	const pi = {
		on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
		events: { on: () => () => {}, emit: () => {} },
		registerTool: () => {},
		registerCommand: (name: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, c),
		getAllTools: () => [],
		sendUserMessage: (text: string, options?: unknown) => sent.push({ text, options }),
	} as unknown as ExtensionAPI;
	createEvals({ env, now: () => Date.parse("2026-11-26T06:00:00.000Z") })(pi);
	const ctx = {
		hasUI: true,
		isIdle: () => true,
		cwd: join(home, "projects", "demo-repo"),
		ui: { notify: (text: string) => notes.push(text), setStatus: () => {} },
		sessionManager: { getSessionId: () => SESSION, getSessionFile: () => undefined, getBranch: () => branch },
	};
	const fire = async (name: string, event: unknown = {}) => {
		let out: unknown;
		for (const h of handlers.get(name) ?? []) out = (await h(event, ctx)) ?? out;
		return out;
	};
	const asksFile = join(state, "asks.jsonl");
	return {
		notes, sent, fire, asksFile, ctx,
		setBranch: (b: unknown[]) => (branch = b),
		ask: (args: string) => commands.get("ask-ai")!.handler(args, ctx),
		call: (toolName: string, input: Record<string, unknown> = {}) => fire("tool_call", { type: "tool_call", toolCallId: "c1", toolName, input }) as Promise<{ block?: boolean; reason?: string } | undefined>,
		raw: () => (existsSync(asksFile) ? readFileSync(asksFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
	};
}

const QUESTION = "你剛剛為什麼沒先跑測試？";

test("/ask-ai sends the question wrapped in a short answer-now instruction", async () => {
	const h = setup();
	await h.fire("session_start");
	await h.ask(QUESTION);
	assert.equal(h.sent.length, 1);
	const text = h.sent[0].text;
	assert.equal(text, askPrompt(QUESTION));
	assert.ok(text.endsWith(QUESTION), "the question comes last, verbatim");
	const instruction = text.slice(0, -QUESTION.length);
	assert.ok(instruction.length <= 420, `instruction is ${instruction.length} chars`);
	assert.match(instruction, /answer/i);
	assert.match(instruction, /change nothing/i);
	assert.match(instruction, /dispatch nothing/i);
	assert.match(instruction, /rule/i);
});

test("/ask-ai with no question prints one-line usage and sends nothing", async () => {
	const h = setup();
	await h.ask("   ");
	assert.equal(h.sent.length, 0);
	assert.equal(h.notes.length, 1);
	assert.doesNotMatch(h.notes[0], /\n/);
	assert.match(h.notes[0], /\/ask-ai/);
	assert.deepEqual(h.raw(), []);
});

test("mutating tools are refused only while the /ask-ai turn is open", async () => {
	const h = setup();
	await h.fire("session_start");
	assert.equal(await h.call("write"), undefined, "no window yet");
	await h.ask(QUESTION);
	assert.equal(await h.call("write"), undefined, "the turn has not started");
	await h.fire("before_agent_start", { messageType: "user", prompt: h.sent[0].text });
	const refused = await h.call("write", { path: "a" });
	assert.equal(refused?.block, true);
	assert.doesNotMatch(refused!.reason!, /\n/);
	assert.match(refused!.reason!, /answer/i);
	assert.equal(await h.call("read", { path: "a" }), undefined);
	assert.equal(await h.call("bash", { command: "rm -rf x" }), undefined, "bash is not parsed");
	assert.equal(await h.call("some_unknown_tool"), undefined);
	assert.equal(await h.call("todo", { action: "list" }), undefined);
	assert.equal(await h.call("todo", { action: "get", id: 1 }), undefined);
	assert.equal((await h.call("todo", { action: "create", subject: "x" }))?.block, true);
	assert.equal((await h.call("intercom", { action: "send" }))?.block, true);
	assert.equal(await h.call("intercom", { action: "list" }), undefined);
	for (const name of ["edit", "subagent", "boss_pair", "MonitorCreate", "LoopCreate", "call_tower"]) assert.equal((await h.call(name))?.block, true, name);
	// The user's own prompt message keeps it open; agent_end closes it.
	await h.fire("message_end", { message: { role: "user", content: [{ type: "text", text: h.sent[0].text }] } });
	assert.equal((await h.call("edit"))?.block, true);
	await h.fire("agent_end", {});
	assert.equal(await h.call("edit"), undefined);
});

test("another user message closes the /ask-ai window", async () => {
	const h = setup();
	await h.fire("session_start");
	await h.ask(QUESTION);
	// A prompt queued behind a running turn opens its window with its own user message.
	await h.fire("message_end", { message: { role: "user", content: [{ type: "text", text: h.sent[0].text }] } });
	assert.equal((await h.call("write"))?.block, true);
	await h.fire("message_end", { message: { role: "user", content: "好，那去修吧" } });
	assert.equal(await h.call("write"), undefined);
});

test("the block list is one exported constant", () => {
	for (const name of ["write", "edit", "subagent", "boss_pair", "MonitorCreate", "LoopCreate", "todo", "intercom", "call_tower"]) assert.ok(name in ASK_AI_BLOCKED, name);
	assert.ok(!("bash" in ASK_AI_BLOCKED));
	assert.ok(!("read" in ASK_AI_BLOCKED));
});

test("an ask is recorded without the question text", async () => {
	const h = setup();
	await h.fire("session_start");
	h.setBranch([todo("2026-11-26T05:00:00.000Z", [{ id: 3, subject: "fix", status: "in_progress", uid: "MP-1234" }])]);
	await h.ask(QUESTION);
	assert.deepEqual(h.raw(), [{ session_id: SESSION, at: "2026-11-26T06:00:00.000Z", kind: "ask_ai", project: "demo-repo", item: "MP-1234" }]);
	assert.ok(!readFileSync(h.asksFile, "utf8").includes("測試"));
});

test("the report counts asks and those followed by a label in the same session within 30 minutes", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-evals-askm-"));
	const labels = join(dir, "labels.jsonl"), asks = join(dir, "asks.jsonl"), evals = join(dir, "session-evals.json");
	writeFileSync(evals, "{}");
	const ask = (s: string, at: string) => JSON.stringify({ session_id: s, at, kind: "ask_ai", project: "p" });
	writeFileSync(asks, [ask("s1", "2026-11-25T10:00:00.000Z"), ask("s1", "2026-11-25T12:00:00.000Z"), ask("s2", "2026-11-25T10:00:00.000Z")].join("\n") + "\n");
	const label = (s: string, at: string) => JSON.stringify({ session_id: s, evaluation_name: "other", label: "fail", at, annotator: "human", source: "live", project: "p" });
	// s1's first ask is labelled 20 minutes later; its second 45 minutes later (too late); s2's label is in another session.
	writeFileSync(labels, [label("s1", "2026-11-25T10:20:00.000Z"), label("s1", "2026-11-25T12:45:00.000Z"), label("s3", "2026-11-25T10:05:00.000Z")].join("\n") + "\n");
	const agg = emptyDay();
	agg.sessions = 2;
	const idx: DaysIndex = { v: 1, built: "2026-11-26T00:00:00.000Z", lastExtract: "2026-11-26T00:00:00.000Z", days: { "2026-11-25": { p: agg } }, owners: {}, offeredSkills: [], sessions: { backfill: 2, live: 0, both: 0, subagent: 0, linked: 0 }, range: { start: "2026-11-25T00:00:00.000Z", end: "2026-11-26T00:00:00.000Z" } };
	const rows: SessionRow[] = ["s1", "s2"].map((id) => ({ id: traceId(id, "labels"), s: "2026-11-25T09:00:00.000Z", p: "p", k: 0, c: 0, t: {}, ac: 0, ax: 0, sl: 0, nt: 0, ev: {} }));
	const m = buildModel({ index: idx, rows, changes: [], filter: { since: "2026-11-25" }, windowDays: 3, labelsFile: labels, asksFile: asks, sessionEvalsFile: evals, now: new Date("2026-11-26T06:00:00.000Z") });
	assert.deepEqual(m.labels.asks, { n: 3, labelled: 1 });
	const html = renderHtml(m, "zh");
	assert.match(html, /\/ask-ai/);
	assert.match(html, /3 次/);
	assert.match(html, /30 分鐘內/);
});
