import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionRow } from "../src/aggregate.ts";
import { alertLine, dropTest, findAlerts, readShown, recordShown, uiLocale } from "../src/alerts.ts";
import type { Change } from "../src/changes.ts";

const H = 3_600_000;
const AT = "2026-11-25T00:00:00.000Z";
const LAST = "2026-11-26T12:00:00.000Z";

/** `n` sessions spread over the hours after (or before) `from`, the last `pass` of them passing one detector. */
function rows(from: string, n: number, pass: number, detector = "check_after_last_edit", step = H): SessionRow[] {
	return Array.from({ length: n }, (_, i) => ({
		s: new Date(Date.parse(from) + i * step).toISOString(), p: "demo", k: 0, c: 0, t: {}, ac: 0, ax: 0, sl: 0, nt: 0,
		ev: { [detector]: i >= n - pass ? 1 : 0 },
	}));
}
const before = (n: number, pass: number, detector?: string) => rows(new Date(Date.parse(AT) - n * H).toISOString(), n, pass, detector);
const after = (n: number, pass: number, detector?: string) => rows(AT, n, pass, detector);
const pin = (at: string, pkg: string, from: string, to: string, sha = "abc123def456"): Change => ({ at, kind: "pin", subject: `pin ${pkg} ${to}`, package: pkg, from, to, sha, repo: "weihung-basic-agent", source: "git" });

test("a drop needs ten points and a one-sided two-proportion z of at least 3", () => {
	assert.equal(dropTest({ pass: 30, n: 40 }, { pass: 10, n: 40 }).dropped, true);
	// The plan's example, 61% of 41 to 44% of 23, is within noise.
	const example = dropTest({ pass: 25, n: 41 }, { pass: 10, n: 23 });
	assert.equal(example.dropped, false);
	assert.ok(example.z > 1 && example.z < 2);
	// Significant but under ten points: not a drop.
	assert.equal(dropTest({ pass: 9600, n: 10000 }, { pass: 9300, n: 10000 }).dropped, false);
	// A rise, and rates of 0 or 1 on both sides, are never drops.
	assert.equal(dropTest({ pass: 10, n: 40 }, { pass: 30, n: 40 }).dropped, false);
	assert.equal(dropTest({ pass: 40, n: 40 }, { pass: 40, n: 40 }).dropped, false);
	assert.equal(dropTest({ pass: 0, n: 40 }, { pass: 0, n: 40 }).dropped, false);
});

test("a change with enough sessions on both sides and a clear drop is pending; too few after it is not", () => {
	const change = pin(AT, "pi-anchorloop", "3.3.0", "3.4.0");
	const found = findAlerts({ rows: [...before(30, 27), ...after(25, 8)], changes: [change], lastExtract: LAST, windowDays: 7, minSessions: 20 });
	assert.equal(found.pending.length, 1);
	const a = found.pending[0];
	assert.equal(a.detector, "check_after_last_edit");
	assert.deepEqual([a.before, a.after], [{ pass: 27, n: 30 }, { pass: 8, n: 25 }]);
	assert.equal(a.key, `${AT}|check_after_last_edit`);
	assert.equal(found.waiting.length, 0);
	const early = findAlerts({ rows: [...before(30, 27), ...after(12, 2)], changes: [change], lastExtract: LAST, windowDays: 7, minSessions: 20 });
	assert.equal(early.pending.length, 0);
	assert.deepEqual(early.waiting.map((w) => [w.detector, w.after.n]), [["check_after_last_edit", 12]]);
	// Ten sessions are enough when the setting says so.
	assert.equal(findAlerts({ rows: [...before(30, 27), ...after(12, 2)], changes: [change], lastExtract: LAST, windowDays: 7, minSessions: 10 }).pending.length, 1);
});

test("sessions only count inside the window, and a change outside the lookback is skipped", () => {
	const change = pin(AT, "pi-anchorloop", "3.3.0", "3.4.0");
	// Sessions eight days after the change fall outside the seven-day window.
	const late = rows(new Date(Date.parse(AT) + 8 * 24 * H).toISOString(), 25, 0);
	assert.equal(findAlerts({ rows: [...before(30, 27), ...late], changes: [change], lastExtract: LAST, windowDays: 7, minSessions: 20 }).pending.length, 0);
	const old = findAlerts({ rows: [...before(30, 27), ...after(25, 8)], changes: [change], lastExtract: "2026-12-20T00:00:00.000Z", windowDays: 7, minSessions: 20 });
	assert.equal(old.pending.length, 0);
});

test("changes in one commit are one change point, and nearby points for a detector fold into the strongest", () => {
	const a = pin(AT, "pi-straw-boss", "0.100.2", "0.102.0", "c1");
	const b = pin(AT, "pi-anchorloop", "3.3.0", "3.4.0", "c1");
	const c = pin(new Date(Date.parse(AT) + 2 * H).toISOString(), "pi-evals", "0.5.0", "0.6.0", "c2");
	const data = [...before(30, 27), ...after(25, 8)];
	const found = findAlerts({ rows: data, changes: [a, b, c], lastExtract: LAST, windowDays: 7, minSessions: 20 });
	assert.equal(found.pending.length, 1);
	assert.equal(found.pending[0].at, AT);
	// The anchorloop pin names the point; the other change in its commit is counted.
	assert.equal(found.pending[0].changes[0].package, "pi-anchorloop");
	assert.equal(found.pending[0].changes.length, 2);
	assert.equal(found.pending[0].nearby, 1);
	// A detector already shown near this point keeps the drop from warning again under another change.
	const shown = [{ ...found.pending[0], key: `${c.at}|check_after_last_edit`, at: c.at, shownAt: LAST }];
	assert.equal(findAlerts({ rows: data, changes: [a, b, c], lastExtract: LAST, windowDays: 7, minSessions: 20, shown }).pending.length, 0);
});

test("a shown alert is recorded once and is no longer pending", () => {
	const file = join(mkdtempSync(join(tmpdir(), "pi-evals-alerts-")), "alerts.jsonl");
	const change = pin(AT, "pi-anchorloop", "3.3.0", "3.4.0");
	const input = { rows: [...before(30, 27), ...after(25, 8)], changes: [change], lastExtract: LAST, windowDays: 7, minSessions: 20 };
	const first = findAlerts(input);
	assert.equal(recordShown(file, first.pending[0], LAST), true);
	assert.equal(recordShown(file, first.pending[0], LAST), false);
	const shown = readShown(file);
	assert.deepEqual(shown.map((s) => s.key), [first.pending[0].key]);
	const again = findAlerts({ ...input, shown });
	assert.equal(again.pending.length, 0);
	assert.equal(again.shown.length, 1);
	writeFileSync(file, "not json\n", { flag: "a" });
	assert.equal(readShown(file).length, 1);
});

test("the session-start line names the change, the detector, both rates with counts, and the command, in English or zh-TW", () => {
	const change = pin(AT, "pi-anchorloop", "3.3.0", "3.4.0");
	const [a] = findAlerts({ rows: [...before(41, 25), ...after(23, 2)], changes: [change], lastExtract: LAST, windowDays: 7, minSessions: 20 }).pending;
	assert.equal(alertLine(a, "en", 0), "pi-evals: 23 sessions after anchorloop 3.4.0, “Ran the check after the last edit” fell from 61% to 9% (41 before). /evals alerts for details");
	assert.equal(alertLine(a, "zh-TW", 2), "pi-evals：anchorloop 3.4.0 之後 23 個工作階段，「最後一次修改後有跑檢查」從 61% 掉到 9%（升版前 41 個）。另有 2 項。/evals alerts 看細節");
	const rule: Change = { at: AT, kind: "rule", subject: "rules: tighten", sha: "0123456789ab", repo: "weihung-agent-root", source: "git" };
	const [r] = findAlerts({ rows: [...before(41, 25), ...after(23, 2)], changes: [rule], lastExtract: LAST, windowDays: 7, minSessions: 20 }).pending;
	assert.equal(alertLine(r, "zh-TW", 0), "pi-evals：規則變更 0123456 之後 23 個工作階段，「最後一次修改後有跑檢查」從 61% 掉到 9%（變更前 41 個）。/evals alerts 看細節");
	assert.ok(!alertLine(r, "en", 0).includes("\n"));
});

test("the language is the settings locale, else the environment's", () => {
	assert.equal(uiLocale({ LANG: "en_US.UTF-8" }, "zh-TW"), "zh-TW");
	assert.equal(uiLocale({ LANG: "zh_TW.UTF-8" }), "zh-TW");
	assert.equal(uiLocale({ LC_ALL: "en_US.UTF-8", LANG: "zh_TW.UTF-8" }), "en");
	assert.equal(uiLocale({ LANG: "zh_CN.UTF-8" }), "en");
	assert.equal(uiLocale({ LANG: "zh_TW.UTF-8" }, "en"), "en");
});
