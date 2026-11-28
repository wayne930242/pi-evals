import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionRow } from "../src/aggregate.ts";
import { createEvals } from "../src/index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
const H = 3_600_000;
const AT = "2026-11-25T00:00:00.000Z";

function row(t: number, pass: boolean): SessionRow {
	return { s: new Date(t).toISOString(), p: "demo", k: 0, c: 0, t: {}, ac: 0, ax: 0, sl: 0, nt: 0, ev: { check_after_last_edit: pass ? 1 : 0, anchor_before_first_edit: 1 } };
}

/** A store with anchorloop 3.4.0 at AT: 41 sessions before (25 pass the check), 23 after (2 pass). */
function setup(options: { lastExtract?: string; settings?: Record<string, unknown>; lang?: string } = {}) {
	const home = mkdtempSync(join(tmpdir(), "pi-evals-alert-"));
	const state = join(home, "state"), config = join(home, "config");
	mkdirSync(join(state, "index"), { recursive: true });
	mkdirSync(join(config, "pi-evals"), { recursive: true });
	writeFileSync(join(config, "pi-evals", "settings.json"), JSON.stringify({ changeRepos: [], ...options.settings }));
	const at = Date.parse(AT);
	const rows = [
		...Array.from({ length: 41 }, (_, i) => row(at - (41 - i) * H, i >= 16)),
		...Array.from({ length: 23 }, (_, i) => row(at + i * H, i >= 21)),
	];
	writeFileSync(join(state, "index", "sessions.json"), JSON.stringify(rows));
	writeFileSync(join(state, "index", "status.json"), JSON.stringify({ lastExtract: options.lastExtract ?? "2026-11-26T00:30:00.000Z" }));
	writeFileSync(join(state, "changes.jsonl"), `${JSON.stringify({ at: AT, kind: "pin", subject: "pin anchorloop", package: "pi-anchorloop", from: "3.3.0", to: "3.4.0", sha: "abc123def456", source: "git" })}\n`);
	const env = { HOME: home, PI_CODING_AGENT_DIR: join(home, "agent"), PI_EVALS_STATE_DIR: state, XDG_CONFIG_HOME: config, LANG: options.lang ?? "en_US.UTF-8" };
	const handlers = new Map<string, Handler[]>();
	const notes: { text: string; level: string }[] = [];
	let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
	const checks: Promise<void>[] = [];
	const pi = {
		on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
		events: { on: () => () => {}, emit: () => {} },
		registerTool: () => {},
		registerCommand: (_name: string, c: typeof command) => (command = c),
		getAllTools: () => [],
	} as unknown as ExtensionAPI;
	createEvals({ env, now: () => Date.parse("2026-11-26T01:00:00.000Z"), onAlertCheck: (p) => checks.push(p) })(pi);
	const ctxFor = (file?: string) => ({
		hasUI: true,
		cwd: join(home, "projects", "demo"),
		ui: { notify: (text: string, level: string) => notes.push({ text, level }), setStatus: () => {} },
		sessionManager: { getSessionId: () => "s1", getSessionFile: () => file },
	});
	const start = async (file?: string) => {
		const before = checks.length;
		for (const h of handlers.get("session_start") ?? []) await h({ reason: "startup" }, ctxFor(file));
		await Promise.all(checks.slice(before));
	};
	return { state, notes, start, run: (args: string) => command!.handler(args, ctxFor()) };
}

test("a main session's start shows one line for a clear drop, once, and records it", async () => {
	const h = setup();
	await h.start("/s/2026-11-26T00-59-00-000Z_01a20000-0000-7000-8000-000000000009.jsonl");
	const alerts = h.notes.filter((n) => n.text.startsWith("pi-evals: 23 sessions"));
	assert.deepEqual(alerts.map((n) => n.text), ["pi-evals: 23 sessions after anchorloop 3.4.0, “Ran the check after the last edit” fell from 61% to 9% (41 before). /evals alerts for details"]);
	assert.equal(alerts[0].level, "warning");
	const shown = readFileSync(join(h.state, "alerts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(shown.map((s) => [s.key, s.shownAt]), [[`${AT}|check_after_last_edit`, "2026-11-26T01:00:00.000Z"]]);
	await h.start();
	assert.equal(h.notes.filter((n) => n.text.startsWith("pi-evals: 23")).length, 1);
	await h.run("alerts");
	const listed = h.notes.at(-1)!.text;
	assert.match(listed, /pending \(0\)/);
	assert.match(listed, /shown \(1\)\n {2}2026-11-25T00:00:00.000Z anchorloop 3.4.0 · Ran the check after the last edit \(check_after_last_edit\): 25\/41 \(61.0%\) → 2\/23 \(8.7%\), z \d\.\d\d; shown 2026-11-26T01:00:00.000Z/);
	assert.match(listed, /z-test z >= 3/);
});

test("the line follows the locale setting", async () => {
	const h = setup({ settings: { locale: "zh-TW" } });
	await h.start();
	assert.equal(h.notes.at(-1)?.text, "pi-evals：anchorloop 3.4.0 之後 23 個工作階段，「最後一次修改後有跑檢查」從 61% 掉到 9%（升版前 41 個）。/evals alerts 看細節");
});

test("a subagent, stale data, a higher minimum, or alerts turned off show nothing", async () => {
	const child = setup();
	await child.start("/s/2026-11-26T00-59-00-000Z_01a20000-0000-7000-8000-000000000001-abcdef01-23456789-abcd.jsonl");
	assert.equal(child.notes.length, 0);
	assert.equal(existsSync(join(child.state, "alerts.jsonl")), false);
	const stale = setup({ lastExtract: "2026-11-25T00:00:00.000Z" });
	await stale.start();
	assert.equal(stale.notes.length, 0);
	await stale.run("alerts");
	assert.match(stale.notes.at(-1)!.text, /last extract 2026-11-25T00:00:00.000Z \(25h ago\), so session start stays quiet/);
	assert.match(stale.notes.at(-1)!.text, /pending \(1\)/);
	const strict = setup({ settings: { alertMinSessions: 30 } });
	await strict.start();
	assert.equal(strict.notes.length, 0);
	await strict.run("alerts");
	assert.match(strict.notes.at(-1)!.text, /looks lower, under 30 sessions after so far \(1\)/);
	const off = setup({ settings: { changeAlerts: false } });
	await off.start();
	assert.equal(off.notes.length, 0);
});
