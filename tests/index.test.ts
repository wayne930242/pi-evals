import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emptyDay } from "../src/aggregate.ts";
import { type DaysIndex, liveSummary, overlayLive } from "../src/build.ts";
import type { Change } from "../src/changes.ts";
import { coverage } from "../src/coverage.ts";
import { extract } from "../src/extract/run.ts";
import { buildModel } from "../src/model.ts";
import { layout } from "../src/paths.ts";
import { record } from "../src/schema.ts";
import { richSession, sessionLines, writeAgentDir } from "./fixtures.ts";

function index(days: Record<string, number>): DaysIndex {
	const cube: DaysIndex["days"] = {};
	for (const [day, sessions] of Object.entries(days)) {
		const agg = emptyDay();
		agg.sessions = sessions;
		agg.tools.bash = { calls: sessions * 10, errors: sessions, durSum: 0, durN: 0 };
		cube[day] = { p: agg };
	}
	return { v: 1, built: "2026-11-26T00:00:00.000Z", lastExtract: "2026-11-26T00:00:00.000Z", days: cube, owners: {}, offeredSkills: [], sessions: { backfill: 0, live: 0, both: 0, subagent: 0, linked: 0 }, anchorloopVersions: {} };
}

const model = (idx: DaysIndex, changes: Change[], labels = "/nonexistent", evals = "/nonexistent") =>
	buildModel({ index: idx, changes, filter: {}, windowDays: 3, labelsFile: labels, sessionEvalsFile: evals, now: new Date("2026-11-26T01:00:00.000Z") });

test("a change compares the days before and after, flags small samples and nearby changes", () => {
	const idx = index({ "2026-11-17": 30, "2026-11-18": 30, "2026-11-19": 30, "2026-11-20": 5, "2026-11-21": 5, "2026-11-22": 5 });
	const change: Change = { at: "2026-11-20T08:00:00.000Z", kind: "pin", subject: "bump", package: "pi-x", from: "1", to: "2", source: "git", sha: "a" };
	const near: Change = { at: "2026-11-21T08:00:00.000Z", kind: "rule", subject: "rule", source: "git", sha: "b" };
	const same: Change = { at: "2026-11-20T08:00:00.000Z", kind: "rule", subject: "same commit", source: "git", sha: "a" };
	const m = model(idx, [change, near, same]);
	const c = m.changes.find((x) => x.subject === "bump");
	assert.equal(c?.impact?.before.sessions, 90);
	assert.equal(c?.impact?.after.sessions, 15);
	assert.equal(c?.impact?.smallSample, true);
	assert.equal(c?.impact?.confounded, 1, "the same commit does not confound itself");
	assert.equal(c?.impact?.before.tool_error_rate.value, 0.1);
	assert.equal(m.changes.find((x) => x.subject === "bump")?.impact?.window.before.since, "2026-11-17");
});

test("every metric and detector carries plain-language metadata in both languages", () => {
	const m = model(index({ "2026-11-24": 1 }), []);
	for (const meta of [...Object.values(m.meta.metrics), ...Object.values(m.meta.detectors)]) {
		for (const field of [meta.label, meta.meaning, meta.howComputed]) {
			assert.ok(field.en.length > 3 && field.zh.length > 1);
			assert.doesNotMatch(field.en, /kappa|pass\^k|TPR|p-value/i);
		}
		assert.ok(["higher", "lower", "none"].includes(meta.goodDirection));
	}
	for (const d of Object.values(m.meta.detectors)) assert.ok(d.example.pass.en && d.example.fail.zh);
	assert.equal(m.freshness.stale, false);
	assert.equal(m.labels.present, false, "no labels file: empty state");
});

test("human labels join with code results per session and detector", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-evals-labels-"));
	const labels = join(dir, "labels.jsonl");
	const evals = join(dir, "session-evals.json");
	writeFileSync(evals, JSON.stringify({ s1: { anchor_before_first_edit: "pass" }, s2: { anchor_before_first_edit: "fail" } }));
	writeFileSync(labels, `${JSON.stringify({ session_id: "s1", evaluation_name: "anchor_before_first_edit", label: "pass" })}\n${JSON.stringify({ session_id: "s2", evaluation_name: "anchor_before_first_edit", label: "pass" })}\n`);
	const m = model(index({ "2026-11-24": 1 }), [], labels, evals);
	assert.deepEqual(m.labels.agreement, [{ detector: "anchor_before_first_edit", n: 2, agree: 1, rate: { value: 0.5, n: 2 } }]);
});

test("live records fill a session no file covers, and lay monitor endings and answer sources over back-fill", () => {
	const rec = (name: string, ts: string, attrs: Record<string, string | number | boolean>, duration?: number) => record({ name, kind: "span", ts, end_ts: ts, duration_ms: duration, source: "live", attrs: { "session.id": "s", "pi.project": "p", ...attrs } });
	const live = [
		rec("pi.session", "2026-11-26T00:00:00.000Z", {}),
		rec("execute_tool", "2026-11-26T00:00:01.000Z", { "gen_ai.tool.name": "ask_user_question", "pi.ask_user.source": "remote", "pi.ask_user.cancelled": false }, 5000),
		rec("pi.monitor", "2026-11-26T00:00:09.000Z", { "pi.monitor.status": "error" }, 8000),
	];
	const alone = liveSummary(live);
	assert.equal(alone.days["2026-11-26"].sessions, 1);
	assert.deepEqual(alone.days["2026-11-26"].ask.sources, { remote: 1 });
	const backfill = emptyDay();
	backfill.ask.calls = 1;
	backfill.ask.sources = { unknown: 1 };
	backfill.monitors = { started: 2, finished: 1, statuses: { completed: 1 }, durSum: 0, durN: 0 };
	const merged = overlayLive({ "2026-11-26": backfill }, live)["2026-11-26"];
	assert.deepEqual(merged.ask.sources, { unknown: 0, remote: 1 });
	assert.equal(merged.ask.calls, 1, "the call is not counted twice");
	assert.deepEqual(merged.monitors.statuses, { error: 1 });
	assert.equal(merged.monitors.started, 2);
});

test("extract is incremental and coverage counts old files by whether the index holds their current version", async () => {
	const home = mkdtempSync(join(tmpdir(), "pi-evals-inc-"));
	const agentDir = writeAgentDir([
		{ dir: "--a--", file: "2026-09-01T00-00-00-000Z_s-old.jsonl", spec: richSession(home, "s-old", "2026-09-01T00:00:00.000Z") },
		{ dir: "--a--", file: "2026-11-24T00-00-00-000Z_s-new.jsonl", spec: richSession(home, "s-new") },
	]);
	const roots = [join(agentDir, "sessions")];
	const oldFile = join(roots[0], "--a--", "2026-09-01T00-00-00-000Z_s-old.jsonl");
	const old = new Date("2026-09-01T00:00:00.000Z");
	utimesSync(oldFile, old, old);
	const lay = layout(join(home, "state"));
	const first = await extract({ roots, layout: lay, home, workers: 0 });
	assert.equal(first.stats.changed, 2);
	const second = await extract({ roots, layout: lay, home, workers: 0 });
	assert.equal(second.stats.changed, 0);
	const now = Date.parse("2026-11-26T00:00:00.000Z");
	assert.deepEqual(coverage(roots, second.checkpoint, 60, now).indexed.files, 1);
	writeFileSync(oldFile, sessionLines(richSession(home, "s-old", "2026-09-01T00:00:00.000Z")).repeat(1));
	utimesSync(oldFile, old, new Date("2026-09-02T00:00:00.000Z"));
	const cov = coverage(roots, second.checkpoint, 60, now);
	assert.equal(cov.notIndexed.files, 1, "a file changed since extraction is not covered");
	const third = await extract({ roots, layout: lay, home, workers: 2 });
	assert.equal(third.stats.changed, 1);
});
