import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emptyDay } from "../src/aggregate.ts";
import { layout } from "../src/paths.ts";
import { model, runReport } from "../src/ops.ts";
import { query } from "../src/query.ts";
import { renderHtml } from "../src/render.ts";

function fixture() {
	const home = mkdtempSync(join(tmpdir(), "pi-evals-findings-"));
	const env = { HOME: home, PI_EVALS_STATE_DIR: home };
	const l = layout(home);
	mkdirSync(join(home, "index"));
	const day = (errors: number, other = false) => {
		const a = emptyDay();
		a.tools.bash = { calls: 100, errors, durSum: 0, durN: 0 };
		a.tools.rare = { calls: 19, errors: errors ? 19 : 0, durSum: 0, durN: 0 };
		a.monitors.finished = 20;
		a.monitors.statuses = { error: errors, completed: 20 - errors };
		if (other) a.tools.bash.errors = 0;
		return a;
	};
	const lastExtract = "2026-02-15T12:00:00.000Z";
	writeFileSync(l.days, JSON.stringify({ v: 1, built: lastExtract, lastExtract, days: {
		"2026-01-01": { old: day(9) },
		"2026-02-01": { p: day(0), elsewhere: day(0, true) },
		"2026-02-14": { p: day(5), elsewhere: day(0, true) },
		"2026-02-15": { p: day(0) },
	}, owners: { bash: { owner: "week-pkg" }, rare: { owner: "tiny-pkg" } },
		range: { start: "2026-01-01T12:00:00Z", end: lastExtract }, sessions: {}, offeredSkills: ["unused"] }));
	writeFileSync(l.changes, JSON.stringify({ at: "2026-02-12T00:00:00Z", kind: "model-routing", source: "git", subject: "private change text" }));
	return env;
}

test("findings carries the report headline and verdicts, freshness, skill and cleanup pointers without prose from a change", () => {
	const env = fixture(), text = query("findings", { env });
	const html = renderHtml(model({}, env, false)!, "en");
	for (const re of [/<h1>([^<]+)<\/h1>/, /<p class="deck">([^<]+)<\/p>/, /<span class="verdict">([^<]+)<\/span>/]) {
		const match = html.match(re); assert.ok(match); assert.ok(text.includes(match[1]), match[1]);
	}
	assert.ok(text.includes(new URL("../scripts", import.meta.url).pathname));
	assert.match(text, /STALE.*2026-02-15/);
	assert.match(text, /model-routing.*→ changes/);
	assert.match(text, /1.*never loaded.*→ skills/);
	assert.match(text, /no old files.*→ coverage/i);
	assert.doesNotMatch(text, /private change text/);
	assert.ok(Buffer.byteLength(text) <= 1500);
});

test("report defaults to 30 UTC dates, four linked pages agree with queries; custom ranges keep their own page", () => {
	const env = fixture();
	const output = runReport({ env, lang: "en" })!;
	const read = (path: string) => readFileSync(join(env.HOME, "reports", path), "utf8");
	for (const suffix of ["", "-14d", "-90d", "-all"]) {
		const html = read(`report${suffix}.html`);
		for (const target of ["", "-14d", "-90d", "-all"]) assert.ok(html.includes(`href="report${target}.html"`));
		assert.match(html, new RegExp(`href="report${suffix}.html" aria-current="page"`));
		assert.doesNotMatch(html, /<script/);
	}
	assert.equal(JSON.parse(readFileSync(output.json, "utf8")).totals.toolCalls, 595);
	assert.match(query("packages", { env }), /2026-01-17\.\.2026-02-15/);
	assert.match(query("packages", { env, since: "2026-01-01" }), /week-pkg: 600/);
	const custom = runReport({ env, filter: { days: 1 } })!;
	assert.notEqual(custom.html, output.html);
	assert.equal(JSON.parse(readFileSync(custom.json, "utf8")).totals.toolCalls, 119);
	assert.match(readFileSync(custom.html, "utf8"), /2026-02-15/);
});

test("compare full UTC weeks by project: include a 5-point rise, exclude low volume and the extraction day", () => {
	const env = fixture(), text = query("findings", { env, project: "p" });
	assert.match(text, /week-pkg.*0\/100.*5\/100.*→ packages/);
	assert.match(query("findings", { env, days: 14, project: "p" }), /week-pkg/);
	assert.doesNotMatch(query("findings", { env, days: 13, project: "p" }), /week-pkg/);
	assert.doesNotMatch(text, /tiny-pkg/);
	assert.match(text, /0\/20.*5\/20.*→ monitors/);
	assert.doesNotMatch(query("findings", { env, project: "elsewhere" }), /week-pkg/);
	assert.doesNotMatch(query("findings", { env, since: "2026-02-09" }), /week-pkg/);
});
