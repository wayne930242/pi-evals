import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyDay } from "../src/aggregate.ts";
import type { Change } from "../src/changes.ts";
import { buildModel } from "../src/model.ts";
import { renderHtml } from "../src/render.ts";
import { select } from "../src/report/findings.ts";
import { periodRows } from "../src/report/week.ts";

const at = "2026-11-10T12:00:00.000Z";
const change = (kind: Change["kind"], subject: string): Change => ({ at, kind, subject, source: "mark" });
function fixture(changes: Change[], n = 24) {
	const agg = emptyDay();
	agg.sessions = 2 * n;
	return buildModel({
		index: {
			v: 1,
			built: at,
			lastExtract: "2026-11-19T00:00:00Z",
			days: { "2026-11-10": { p: agg } },
			range: { start: "2026-11-01T00:00:00Z", end: "2026-11-19T00:00:00Z" },
			sessions: { live: 0, both: 0, backfill: 2 * n, linked: 0, subagent: 0 },
			offeredSkills: [],
			owners: {},
		},
		rows: Array.from(
			{ length: 2 * n },
			(_, i) => ({
				s: `2026-11-10T${i < n ? "11" : "13"}:00:00Z`,
				p: "p",
				k: 0,
				ac: 0,
				ax: 0,
				c: 1,
				nt: 0,
				sl: 0,
				t: { bash: [10, i < n ? 2 : 1] },
				ev: {},
			}),
		),
		changes,
		filter: {},
		windowDays: 7,
		labelsFile: "/nonexistent",
		sessionEvalsFile: "/nonexistent",
		now: new Date("2026-11-19T00:01:00Z"),
	});
}
const hero = (html: string) => html.match(/<h1>(.*?)<\/h1>/s)?.[1] ?? "";
test("headline names the observed direction, never an effect; verdict carries all caveats", () => {
	const model = fixture([change("model-routing", "one")]);
	assert.match(hero(renderHtml(model)), /工具出錯比例下降/);
	assert.match(renderHtml(model), /看得出變化/);
	const imp = model.changes[0].impact!;
	imp.after.tool_error_rate = imp.before.tool_error_rate;
	assert.match(hero(renderHtml(model)), /持平/);
	imp.confounded = 3;
	imp.incomplete = true;
	imp.smallSample = true;
	const html = renderHtml(model);
	for (const note of ["同期還有 3 筆別的調整", "無法分辨是哪一筆造成的", "樣本太少", "未滿 7 天"]) assert.ok(html.includes(note), note);
});
test("only eligible changes are highlighted, folded changes still have reachable detail anchors", () => {
	const html = renderHtml(fixture([change("pin", "pin"), change("rule", "folded <note>"), change("model-routing", "route")], 3));
	assert.match(html, /<details class="day"[^>]*><summary>[^<]*2026-11-10/);
	assert.ok(!html.includes("folded <note>"));
	assert.ok(html.includes("folded &lt;note&gt;"));
	const links = [...html.matchAll(/href="#(change-[^"]+)"/g)].map((m) => m[1]);
	assert.equal(new Set(links).size, 3);
	for (const id of links) assert.ok(html.includes(`id="${id}"`));
	assert.match(hero(renderHtml(fixture([]))), /沒有調整/);
});

test("change strip marks each change, counts dense dates and links only the two card labels to real details", () => {
	const m = fixture(Array.from({length: 9}, (_, i) => change(i < 6 ? "pin" : "manual", `edit ${i}`)));
	const html = renderHtml(m, "en", 30), strip = html.match(/<section class="change-strip">(.*?)<\/section>/s)?.[1] ?? "";
	assert.equal([...strip.matchAll(/class="change-mark /g)].length, 9);
	assert.match(strip, /9 changes/); assert.match(strip, /Package version: 6/);
	assert.match(strip, /×9/);
	const targets = [...strip.matchAll(/href="#(change-\d+)"/g)];
	assert.equal(targets.length, 2);
	for (const [,id] of targets) assert.ok(html.includes(`id="${id}"`));
	assert.match(html, /class="work-mark kind-pin"/);
});

test("the latest eligible process pin leads; a small rule change stays in the archive", () => {
	const m = fixture([change("pin", "anchor"), change("rule", "small")]);
	const [pin, rule] = m.changes;
	pin.package = "pi-anchorloop";
	pin.impact!.before.anchor_before_first_edit = { value: 0.2, n: 20 };
	pin.impact!.after.anchor_before_first_edit = { value: 0.5, n: 20 };
	rule.at = "2026-11-11T00:00:00Z";
	assert.equal(select(m).lead, pin);
	assert.match(hero(renderHtml(m)), /先說驗證方法的比例上升/);
	rule.impact!.smallSample = true;
	assert.deepEqual(select(m).folded, [rule]);
});

test("range chart includes extraction day, counts changes and does not skip empty calendar dates", () => {
	const m = fixture([change("pin", "one")]);
	m.window.since = "2026-11-01";
	m.window.until = "2026-11-14";
	m.freshness.lastExtract = "2026-11-14T01:00:00Z";
	const w = periodRows(m);
	assert.deepEqual([w.length, w[0].day, w.at(-1)?.day], [5, "2026-11-10", "2026-11-14"]);
	assert.equal(w.find((r) => r.day === "2026-11-10")?.changes, 1);
	assert.equal(w.reduce((s, r) => s + r.sessions, 0), 48);
});
