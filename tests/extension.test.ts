import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createEvals } from "../src/index.ts";
import { runExtract } from "../src/ops.ts";
import { setKnownProjects } from "../src/project.ts";
import { MAX_BYTES, VIEWS } from "../src/query.ts";
import { richSession, SECRET, writeAgentDir } from "./fixtures.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function setup(options: { eventsAsFile?: boolean; settings?: string; extraEnv?: Record<string, string> } = {}) {
	const home = mkdtempSync(join(tmpdir(), "pi-evals-ext-"));
	setKnownProjects(["demo-repo"]);
	const state = join(home, "state");
	const config = join(home, "config");
	mkdirSync(join(config, "pi-evals"), { recursive: true });
	writeFileSync(join(config, "pi-evals", "settings.json"), options.settings ?? JSON.stringify({ changeRepos: [] }));
	if (options.eventsAsFile) {
		mkdirSync(state, { recursive: true });
		writeFileSync(join(state, "events"), "not a dir");
	}
	const agentDir = writeAgentDir([{ dir: "--demo--", file: "2026-11-24T10-00-00-000Z_01a20000-0000-7000-8000-000000000001.jsonl", spec: richSession(home) }]);
	const env = { HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_EVALS_STATE_DIR: state, XDG_CONFIG_HOME: config, ...options.extraEnv };
	const handlers = new Map<string, Handler[]>();
	const bus = new EventEmitter();
	const notes: { text: string; level: string }[] = [];
	const statuses: (string | undefined)[] = [];
	let tool: ToolDefinition | undefined;
	let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
	let clock = Date.parse("2026-11-26T01:00:00.000Z");
	const pi = {
		on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
		events: { on: (ch: string, h: (d: unknown) => void) => (bus.on(ch, h), () => bus.off(ch, h)), emit: (ch: string, d: unknown) => bus.emit(ch, d) },
		registerTool: (t: ToolDefinition) => (tool = t),
		registerCommand: (_name: string, c: typeof command) => (command = c),
		getAllTools: () => [
			{ name: "read", sourceInfo: { path: "builtin:read", source: "builtin" } },
			{ name: "ask_user_question", sourceInfo: { path: join(home, "nm", "rpiv", "dist", "index.js"), source: "npm:rpiv" } },
		],
	} as unknown as ExtensionAPI;
	mkdirSync(join(home, "nm", "rpiv", "dist"), { recursive: true });
	writeFileSync(join(home, "nm", "rpiv", "package.json"), JSON.stringify({ name: "@juicesharp/rpiv-ask-user-question", version: "2.15.0" }));
	const spawned: string[][] = [];
	const fakeSpawn = ((cmd: string, args: string[]) => {
		spawned.push([cmd, ...args]);
		const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		setImmediate(() => {
			child.stdout.emit("data", Buffer.from(`${JSON.stringify({ progress: { done: 1, total: 2, bytes: 10 } })}\n${JSON.stringify({ result: { stats: { changed: 2, files: 2, records: 9, mbPerSec: 1, failed: 0 } } })}\n`));
			child.emit("close", 0);
		});
		return child;
	}) as never;
	createEvals({ env, spawnExtract: fakeSpawn, now: () => clock })(pi);
	const ctx = {
		hasUI: true,
		cwd: join(home, "projects", "demo-repo"),
		ui: { notify: (text: string, level: string) => notes.push({ text, level }), setStatus: (_k: string, v?: string) => statuses.push(v) },
		sessionManager: { getSessionId: () => "live-session-1" },
	};
	const fire = async (name: string, event: unknown = {}) => {
		for (const h of handlers.get(name) ?? []) await h(event, ctx);
	};
	return { home, env, state, bus, notes, statuses, spawned, fire, ctx, tick: (ms: number) => (clock += ms), now: () => clock, tool: () => tool as ToolDefinition, command: () => command as NonNullable<typeof command> };
}

const eventsOf = (state: string) =>
	readFileSync(join(state, "events", "2026-11-26.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));

test("the observer records tool owners, finished tool calls, skill loads, monitors, and the ask-user answer source", async () => {
	const h = setup({ extraEnv: { PI_SUBAGENT_ID: "inherited" } });
	await h.fire("session_start", { reason: "startup" });
	await h.fire("before_agent_start", { messageType: "user", systemPromptOptions: { skills: [{ name: "coding", filePath: "/x/coding/SKILL.md" }] } });
	await h.fire("input", { text: "/skill:inspecting please" });
	await h.fire("tool_execution_start", { toolCallId: "t1", toolName: "read", args: { path: "/x/skills/coding/SKILL.md" } });
	await h.fire("tool_execution_end", { toolCallId: "t1", toolName: "read", result: { content: [{ type: "text", text: SECRET }] }, isError: false, durationMs: 5 });
	await h.fire("tool_execution_start", { toolCallId: "t2", toolName: "ask_user_question", args: { questions: [{ question: SECRET }] } });
	h.bus.emit("rpiv:ask-user:answer", { toolCallId: "t2", answers: [SECRET] });
	h.bus.emit("rpiv:ask-user:answer-result", { ok: true, toolCallId: "t2", requestId: "r1" });
	await h.fire("tool_execution_end", { toolCallId: "t2", toolName: "ask_user_question", result: { details: { cancelled: false, answers: [{ answer: SECRET }] } }, isError: false, durationMs: 9000 });
	await h.fire("tool_execution_end", { toolCallId: "t3", toolName: "bash", result: {}, isError: true });
	await h.fire("tool_execution_start", { toolCallId: "t4", toolName: "ask_user_question", args: { questions: [{}] } });
	h.bus.emit("rpiv:ask-user:answer", { toolCallId: "t4", answers: ["x"] });
	h.bus.emit("rpiv:ask-user:answer-result", { ok: false, code: "stale", toolCallId: "t4" });
	await h.fire("tool_execution_end", { toolCallId: "t4", toolName: "ask_user_question", result: { details: { cancelled: false } }, isError: false, durationMs: 100 });
	h.bus.emit("monitor:started", { monitorId: "7", command: SECRET, timestamp: h.now() - 4000 });
	h.bus.emit("monitor:finished", { monitorId: "7", status: "completed", exitCode: 0, outputLines: 3 });
	h.bus.emit("monitor:done", { monitorId: "7", exitCode: 0 });
	await h.fire("message_end", { message: { role: "custom", customType: "pi-herdr-agents:declared-skills", content: '<skill name="agent-terse" location="/x">' } });

	const recs = eventsOf(h.state);
	const by = (name: string) => recs.filter((r) => r.name === name);
	assert.equal(by("pi.tools.snapshot").length, 1);
	assert.deepEqual(by("pi.tools.snapshot")[0].attrs["pi.tools"], ["ask_user_question=@juicesharp/rpiv-ask-user-question@2.15.0", "read=pi:builtin"]);
	assert.deepEqual(by("pi.skills.available")[0].attrs["pi.skills"], ["coding"]);
	assert.deepEqual(by("pi.skill.load").map((r) => [r.attrs["gen_ai.skill.name"], r.attrs["pi.skill.trigger"]]), [["inspecting", "slash"], ["coding", "read"], ["agent-terse", "declared"]]);
	const tools = by("execute_tool");
	assert.equal(tools.length, 4);
	assert.equal(tools[3].attrs["pi.ask_user.source"], "terminal", "a rejected remote answer is not the answer's source");
	assert.equal(by("pi.session")[0].attrs["pi.session.kind"], "interactive", "an inherited PI_SUBAGENT_ID does not make a subagent");
	assert.equal(tools[1].attrs["pi.tool.owner"], "@juicesharp/rpiv-ask-user-question");
	assert.equal(tools[1].attrs["pi.tool.owner_version"], "2.15.0");
	assert.equal(tools[1].attrs["pi.ask_user.source"], "remote");
	assert.equal(tools[1].attrs["pi.ask_user.questions"], 1);
	assert.equal(tools[2].attrs["error.type"], "tool_error", "a call that never ran is still recorded");
	assert.equal(tools[2].attrs["pi.duration.source"], "not_run");
	const monitors = by("pi.monitor");
	assert.equal(monitors.length, 1, "finished and done for one monitor make one record");
	assert.equal(monitors[0].attrs["pi.monitor.status"], "completed");
	assert.ok(monitors[0].duration_ms >= 4000);
	assert.ok(!readFileSync(join(h.state, "events", "2026-11-26.jsonl"), "utf8").includes("PLANTED"));
});

test("a broken settings file loads with defaults and says so once", async () => {
	const h = setup({ settings: "{ not json" });
	await h.fire("session_start", {});
	await h.fire("session_start", {});
	assert.equal(h.notes.filter((n) => n.text.includes("settings")).length, 1);
	await h.command().handler("status", h.ctx);
	assert.match(h.notes.at(-1)?.text ?? "", /settings: .*using defaults/);
});

test("a change repository that is not a git repository is reported, and the extract still finishes", async () => {
	const h = setup({ settings: JSON.stringify({ changeRepos: [tmpdir()] }) });
	const status = await runExtract({ env: h.env, workers: 0 });
	assert.equal(status.sessions.backfill, 1);
	assert.match(readFileSync(join(h.state, "index", "status.json"), "utf8"), /git log/);
});

test("a failing write warns once and never throws into the turn", async () => {
	const h = setup({ eventsAsFile: true });
	await h.fire("session_start", {});
	await h.fire("tool_execution_end", { toolCallId: "a", toolName: "bash", result: {}, isError: false, durationMs: 1 });
	await h.fire("tool_execution_end", { toolCallId: "b", toolName: "bash", result: {}, isError: false, durationMs: 1 });
	assert.equal(h.notes.filter((n) => n.level === "warning" && n.text.includes("cannot write records")).length, 1);
});

test("/evals status, report, mark, and extract", async () => {
	const h = setup();
	const cmd = h.command();
	await cmd.handler("", h.ctx);
	assert.match(h.notes.at(-1)?.text ?? "", /no extract yet/);
	await cmd.handler("report", h.ctx);
	assert.match(h.notes.at(-1)?.text ?? "", /nothing extracted yet/);
	await runExtract({ env: h.env, workers: 0 });
	await cmd.handler("report --since 2026-11-01", h.ctx);
	const reportNote = h.notes.at(-1)?.text ?? "";
	assert.match(reportNote, /report: .*report-custom\.html/);
	const html = readFileSync(reportNote.match(/report: (\S+)/)?.[1] ?? "", "utf8");
	assert.match(html, /<svg/);
	assert.doesNotMatch(html, /<script|https?:\/\/|<link /, "no scripts and no network assets");
	await cmd.handler("findings --days 14", h.ctx);
	assert.match(h.notes.at(-1)?.text ?? "", /→ skills/);
	await cmd.handler("report", h.ctx);
	await cmd.handler("status", h.ctx);
	assert.match(h.notes.at(-1)?.text ?? "", /report: .*report\.html/);
	assert.match(h.notes.at(-1)?.text ?? "", /coverage \(inactive > 60 days\)/);
	await cmd.handler("mark switched workers to gpt-6.2-astra", h.ctx);
	assert.match(readFileSync(join(h.state, "marks.jsonl"), "utf8"), /gpt-6.2-astra/);
	await cmd.handler("extract", h.ctx);
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(h.spawned.length, 1);
	assert.deepEqual(h.spawned[0].slice(-4), ["extract", "--json", "--workers", "2"]);
	await cmd.handler("extract --workers 1", h.ctx);
	assert.deepEqual(h.spawned[1].slice(-4), ["extract", "--json", "--workers", "1"]);
	await new Promise((r) => setImmediate(r));
	await cmd.handler("extract --workers -1", h.ctx);
	assert.equal(h.spawned.length, 2);
	assert.match(h.notes.at(-1)?.text ?? "", /non-negative integer/);
	assert.ok(h.statuses.some((s) => s?.includes("1/2 files")));
	assert.ok(h.notes.some(n=>n.text.includes("extracted 2 changed of 2 files")));
});

test("evals_query answers every view within the size bound, names staleness, and rejects bad input", async () => {
	const h = setup();
	const tool = h.tool();
	const exec = (params: Record<string, unknown>) => tool.execute("id", params as never, undefined, undefined, h.ctx as never);
	const empty = await exec({ view: "skills" });
	assert.match((empty.content[0] as { text: string }).text, /nothing extracted yet/);
	await runExtract({ env: h.env, workers: 0 });
	for (const view of VIEWS) {
		const out = await exec({ view });
		const text = (out.content[0] as { text: string }).text;
		assert.ok(Buffer.byteLength(text) <= MAX_BYTES, `${view}: ${Buffer.byteLength(text)} bytes`);
		// The items view quotes todo titles (the one stored text); nothing else may carry the planted secret.
		assert.ok(!text.replace(/^(\s*(?:[-*] )?)"[^"\n]*"/gm, "$1").includes("PLANTED"), view);
	}
	const skills = (await exec({ view: "skills", project: "demo-repo" })).content[0] as { text: string };
	assert.match(skills.text, /coding: 1 \/ 1/);
	assert.match(skills.text, /unused-skill/, "offered but never loaded");
	const process_ = (await exec({ view: "process" })).content[0] as { text: string };
	assert.match(process_.text, /anchor_before_first_edit .*100\.0% \(n=1\)/);
	await assert.rejects(exec({ view: "nope" }), /Unknown view/);
	await assert.rejects(exec({ view: "skills", since: "yesterday" }), /YYYY-MM-DD/);
	assert.ok(Buffer.byteLength(tool.description) < 300, "short description");
});

test("/evals run lists the shipped scripts in plain words, runs one, completes names, and refuses unknown ones", async () => {
	const h = setup();
	const cmd = h.command() as unknown as { handler: (a: string, c: unknown) => Promise<void>; getArgumentCompletions: (p: string) => { value: string }[] | null };
	await cmd.handler("run", h.ctx);
	const list = h.notes.at(-1)?.text ?? "";
	for (const name of ["freshness", "disagree", "by-version", "sample", "label-import", "session-shape", "change-impact", "skill-days", "package-errors"]) assert.match(list, new RegExp(`^${name}`, "m"));
	assert.match(list, /索引/);
	await runExtract({ env: h.env, workers: 0 });
	await cmd.handler("run freshness", h.ctx);
	assert.match(h.notes.at(-1)?.text ?? "", /Fresh: every summary/);
	assert.equal(h.notes.at(-1)?.level, "info");
	await cmd.handler("run session-shape 01a20000-0000-7000-8000-000000000001", h.ctx);
	assert.match(h.notes.at(-1)?.text ?? "", /anchor_before_first_edit: pass/);
	assert.ok(!h.notes.some((n) => n.text.includes(SECRET)));
	await cmd.handler("run disagree", h.ctx);
	assert.equal(h.notes.at(-1)?.level, "warning");
	await cmd.handler("run ../cli", h.ctx);
	assert.match(h.notes.at(-1)?.text ?? "", /Unknown script/);
	assert.deepEqual(cmd.getArgumentCompletions("run se")?.map((c) => c.value), ["run session-shape"]);
	assert.ok(cmd.getArgumentCompletions("r")?.some((c) => c.value === "run"));
});
