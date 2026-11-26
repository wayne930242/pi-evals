import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emptyDay } from "../src/aggregate.ts";

test("bundled queries count distinct sessions, weight calls, and don't emit model prose or unchecked arguments", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-evals-scripts-"));
	mkdirSync(join(dir, "index")); mkdirSync(join(dir, "reports"));
	const a = emptyDay(); a.skills.coding = 4; a.skillSessions.coding = 1;
	a.tools.read = { calls: 80, errors: 1, durN: 0, durSum: 0 }; a.tools.edit = { calls: 20, errors: 2, durN: 0, durSum: 0 };
	const at = "2026-02-15T12:00:00.000Z", before = { sessions: 3, tool_error_rate: { value: 0.03, n: 100 } };
	writeFileSync(join(dir, "index/days.json"), JSON.stringify({ lastExtract: at, range: { start: "2026-01-01T00:00:00Z" }, owners: {}, offeredSkills: [], days: { "2026-02-14": { p: a } } }));
	writeFileSync(join(dir, "reports/model.json"), JSON.stringify({ window: {}, freshness: { lastExtract: at }, changes: [{ at, package: "pkg", subject: "do not print this", impact: { smallSample: true, incomplete: false, confounded: 3, window: { days: 7 }, before, after: before } }] }));
	// Git checkout with shipped sources and no build artifacts.
	cpSync("scripts", join(dir, "scripts"), { recursive: true });
	symlinkSync(new URL("../src", import.meta.url), join(dir, "src"));
	const invoke = (script: string, arg: string) => {
		const r = spawnSync(process.execPath, [join(dir, `scripts/${script}.mjs`), arg], { env: { ...process.env, PI_EVALS_STATE_DIR: dir }, encoding: "utf8" });
		assert.ok(Buffer.byteLength(r.stdout + r.stderr) <= 2000);
		assert.doesNotMatch(r.stdout + r.stderr, /do not print this/);
		return r;
	};
	assert.match(invoke("skill-days", "coding").stdout, /2026-02-14 1\n/);
	assert.match(invoke("package-errors", "pi:builtin").stdout, /2026-02-14 3\/100 3.0%/);
	assert.match(invoke("change-impact", at).stdout, /tool_error_rate: 0.0300 \(n=100\)/);
	assert.notEqual(invoke("skill-days", "do not print this").status, 0);
});
