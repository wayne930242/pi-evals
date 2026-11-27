import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gateShotsDir, sha256File } from "../src/exp/artifacts.ts";
import { buildFixture } from "../src/exp/fixture.ts";
import type { RunMeta } from "../src/exp/run.ts";
import { show } from "../src/exp/show.ts";
import { summarize } from "../src/exp/summary.ts";
import { loadSuite } from "../src/exp/task.ts";
import { runTrial, type TrialRecord, trialDirOf } from "../src/exp/trial.ts";
import { applyUiAnswer, parseUiAnswer, uiSummary, writeUiReview } from "../src/exp/ui-review.ts";
import { gate } from "../src/exp/validity.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();

/** A PNG header with the given size; `tag` makes otherwise equal images differ. */
function png(w: number, h: number, tag: string): Buffer {
	const head = Buffer.alloc(24);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
	head.writeUInt32BE(13, 8);
	head.write("IHDR", 12, "latin1");
	head.writeUInt32BE(w, 16);
	head.writeUInt32BE(h, 20);
	return Buffer.concat([head, Buffer.from(tag)]);
}

// The fake agent fixes a.txt and writes a one-turn session.
const FAKE_PI = `#!/bin/sh
dir=""
while [ $# -gt 0 ]; do [ "$1" = "--session-dir" ] && dir="$2"; shift; done
mkdir -p "$dir"
echo fixed > a.txt
cat > "$dir/s.jsonl" <<'EOF'
{"type":"session","version":3,"id":"s1","cwd":"x"}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"do it"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Done."}],"usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.1}}}}
EOF
`;

/**
 * A suite with one screenshot task. The shot shows a.txt's content (base or fixed); `mode` "unstable" makes the
 * second reference shot differ, "same" makes the reference look like the base, "none" writes no PNG.
 */
function suite(mode: "ok" | "unstable" | "same" | "none" = "ok") {
	const repo = mkdtempSync(join(tmpdir(), "exp-ui-src-"));
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "t@t");
	git(repo, "config", "user.name", "t");
	writeFileSync(join(repo, "a.txt"), "base\n");
	git(repo, "add", "a.txt");
	git(repo, "commit", "-qm", "base");
	const base = git(repo, "rev-parse", "HEAD");
	const root = mkdtempSync(join(tmpdir(), "exp-ui-suite-"));
	writeFileSync(join(root, "suite.json"), JSON.stringify({ model: "m/x", thinking: "medium" }));
	mkdirSync(join(root, "arms"));
	for (const arm of ["bare", "anchorloop"]) writeFileSync(join(root, "arms", `${arm}.json`), JSON.stringify({}));
	const task = join(root, "tasks", "t1");
	mkdirSync(join(task, "check"), { recursive: true });
	writeFileSync(join(task, "task.json"), JSON.stringify({ id: "t1", kind: "anchor", fixture: { repo, base }, reference: { patch: "reference.patch" }, timeout_min: 1, screenshot: { script: "screenshot.sh", timeout_s: 30 } }));
	writeFileSync(join(task, "prompt.md"), "The icon is drawn too small.\n\n![issue](.issue/bug.png)\n");
	writeFileSync(join(task, "reference.patch"), "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-base\n+fixed\n");
	writeFileSync(join(task, "check", "check.sh"), "#!/bin/sh\ntest -d \"$EXP_ARTIFACT_DIR\" && grep -q fixed a.txt\n");
	writeFileSync(join(task, "check", "base.png"), png(100, 100, "base"));
	writeFileSync(join(task, "check", "fixed.png"), png(100, 100, mode === "same" ? "base" : "fixed"));
	writeFileSync(join(task, "check", "fixed-2.png"), png(100, 100, "fixed, moved"));
	const shot = {
		ok: 'v=$(cat a.txt)\ncp "$EXP_CHECK_DIR/$v.png" "$EXP_ARTIFACT_DIR/shot.png"\n',
		same: 'v=$(cat a.txt)\ncp "$EXP_CHECK_DIR/$v.png" "$EXP_ARTIFACT_DIR/shot.png"\n',
		unstable: 'v=$(cat a.txt)\nif [ "$v" = fixed ] && [ -f "$EXP_CHECK_DIR/seen" ]; then v=fixed-2; fi\ntouch "$EXP_CHECK_DIR/seen"\ncp "$EXP_CHECK_DIR/$v.png" "$EXP_ARTIFACT_DIR/shot.png"\n',
		none: "echo build failed >&2\nexit 2\n",
	}[mode];
	writeFileSync(join(task, "check", "screenshot.sh"), `#!/bin/sh\n${shot}`);
	return root;
}

async function trial(mode: "ok" | "none") {
	const s = loadSuite(suite(mode));
	const fixture = buildFixture(s, s.tasks[0], mkdtempSync(join(tmpdir(), "exp-ui-fx-")));
	const bin = join(mkdtempSync(join(tmpdir(), "exp-ui-bin-")), "pi");
	writeFileSync(bin, FAKE_PI);
	chmodSync(bin, 0o755);
	const runDir = mkdtempSync(join(tmpdir(), "exp-ui-run-"));
	const r = await runTrial({ suite: s, task: s.tasks[0], arm: "bare", n: 1, runDir, fixture, piBin: bin });
	return { r, trialDir: trialDirOf(runDir, "t1", "bare", 1) };
}

test("trial: the screenshot step stores artifacts/shot.png and its sha256", async () => {
	const { r, trialDir } = await trial("ok");
	const shot = join(trialDir, "artifacts", "shot.png");
	assert.ok(existsSync(shot));
	assert.equal(r.outcome, true, "the check saw EXP_ARTIFACT_DIR");
	assert.deepEqual({ ok: r.screenshot?.ok, sha256: r.screenshot?.sha256 }, { ok: true, sha256: sha256File(shot) });
	const grade = JSON.parse(readFileSync(join(trialDir, "grade.json"), "utf8")) as TrialRecord;
	assert.equal(grade.screenshot?.sha256, sha256File(shot));
	assert.equal(grade.screenshot?.exit, 0);
});

test("trial: no PNG gives screenshot ok false and leaves the outcome alone", async () => {
	const { r, trialDir } = await trial("none");
	assert.equal(r.outcome, true);
	assert.equal(r.valid, true);
	assert.equal(r.screenshot?.ok, false);
	assert.equal(r.screenshot?.exit, 2);
	assert.match(readFileSync(join(trialDir, "screenshot.log"), "utf8"), /build failed/);
});

function gated(mode: "ok" | "unstable" | "same") {
	const s = loadSuite(suite(mode));
	const fixture = buildFixture(s, s.tasks[0], mkdtempSync(join(tmpdir(), "exp-ui-fx-")));
	const shots = mkdtempSync(join(tmpdir(), "exp-ui-shots-"));
	return { r: gate(s.tasks[0], fixture, { runs: 1, shotsDir: shots }), shots };
}

test("gate: a stable reference shot that differs from the base passes and is kept", () => {
	const { r, shots } = gated("ok");
	assert.ok(r.ok, r.lines.join("\n"));
	assert.equal(r.lines.filter((l) => /reference run/.test(l)).length, 1, "--ref-runs 1 runs the reference once");
	assert.ok(existsSync(join(shots, "base.png")) && existsSync(join(shots, "reference.png")));
});

test("gate: an unstable reference shot fails", () => {
	const { r } = gated("unstable");
	assert.equal(r.ok, false);
	assert.ok(r.lines.some((l) => /FAIL reference screenshot differs between runs/.test(l)), r.lines.join("\n"));
});

test("gate: a reference shot equal to the base fails", () => {
	const { r } = gated("same");
	assert.equal(r.ok, false);
	assert.ok(r.lines.some((l) => /FAIL reference screenshot equals the base's/.test(l)), r.lines.join("\n"));
});

const eff = { wallMs: 1, turns: 1, toolCalls: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

/** A finished run of the screenshot suite: 2 arms × k=2, shots on disk, one trial without a shot. */
function finishedRun() {
	const suiteDir = suite("ok");
	const s = loadSuite(suiteDir);
	const fixturesRoot = mkdtempSync(join(tmpdir(), "exp-ui-fxr-"));
	const fixture = buildFixture(s, s.tasks[0], fixturesRoot);
	mkdirSync(join(fixture, ".issue"));
	writeFileSync(join(fixture, ".issue", "bug.png"), png(10, 10, "issue"));
	const gs = gateShotsDir(fixturesRoot, "t1");
	mkdirSync(gs, { recursive: true });
	writeFileSync(join(gs, "base.png"), png(100, 100, "base"));
	writeFileSync(join(gs, "reference.png"), png(100, 100, "fixed"));
	const runDir = mkdtempSync(join(tmpdir(), "exp-ui-run-"));
	const meta = { id: "ui1", suite: suiteDir, arms: { bare: {}, anchorloop: {} }, k: 2, tasks: ["t1"] } as unknown as RunMeta;
	const records: TrialRecord[] = [];
	for (const arm of ["bare", "anchorloop"]) {
		for (const n of [1, 2]) {
			const dir = trialDirOf(runDir, "t1", arm, n);
			mkdirSync(join(dir, "artifacts"), { recursive: true });
			const ok = !(arm === "anchorloop" && n === 2);
			if (ok) writeFileSync(join(dir, "artifacts", "shot.png"), png(100, 100, `${arm}${n}`));
			const session = join(dir, "s.jsonl");
			writeFileSync(session, `${JSON.stringify({ type: "session", id: `sess-${arm}-${n}` })}\n`);
			records.push({ task: "t1", kind: "anchor", arm, n, valid: true, outcome: arm === "anchorloop" || n === 1, dirty: true, claimsDone: true, doneClaimVsOutcome: false, notices: 0, timedOut: false, quota: false, efficiency: eff, process: {}, workDir: "", session, screenshot: { ok, ms: 1, exit: ok ? 0 : 1 } });
		}
	}
	return { runDir, meta, records, s, fixturesRoot };
}

test("ui review: the page and its files never name the arm; two seeds give different orders", () => {
	const { runDir, meta, records, s, fixturesRoot } = finishedRun();
	const one = writeUiReview(runDir, meta, records, { suite: s, fixturesRoot, seed: 1 });
	const page = readFileSync(one.page, "utf8");
	const files = readdirSync(join(runDir, "ui-review", "img"));
	assert.equal(one.items.length, 4);
	assert.match(page, /```review/);
	assert.match(page, /pickMode: multi/);
	assert.match(page, /改之前/);
	assert.match(page, /參考答案/);
	assert.match(page, /畫面產生失敗/);
	assert.ok(!/bare|anchorloop|sess-/.test(page), "no arm on the page");
	assert.ok(files.every((f) => /^[0-9a-f]{20}\.png$/.test(f)), files.join(" "));
	assert.ok(!files.some((f) => /bare|anchorloop/.test(f)));
	assert.equal(files.length, 3 + 3, "issue picture, base, reference and three trial shots");
	const order = (seed: number) => writeUiReview(runDir, meta, records, { suite: s, fixturesRoot, seed }).items.map((i) => `${i.arm}${i.n}`).join();
	const orders = new Set([1, 2, 3, 4, 5].map(order));
	assert.ok(orders.size > 1, "the order depends on the seed");
	assert.equal(order(7), order(7), "the same seed gives the same order");
});

test("ui answer: picked is pass, not picked is fail, ? or 看不出 is unclear", () => {
	const v = parseUiAnswer('User reviewed "ui1 畫面檢查":\nPicked: 1-A (第 1 題)\nPicked: 1-C (第 1 題)\n- 1-C (第 1 題): ? 太小看不清\n- 1-B (第 1 題): 圖示偏了\nNo feedback on: 1-A (第 1 題), 1-D (第 1 題)\n', ["1-A", "1-B", "1-C", "1-D"]);
	assert.deepEqual([...v].map(([k, x]) => `${k}:${x.label}`), ["1-A:pass", "1-B:fail", "1-C:unclear", "1-D:fail"]);
	assert.equal(v.get("1-B")?.note, "圖示偏了");
	assert.equal(parseUiAnswer("just some text", ["1-A"]).size, 0);
});

test("ui labels: rows by trial, per-arm rate and agreement with the verifier in exp show", () => {
	const { runDir, meta, records, s, fixturesRoot } = finishedRun();
	const { items } = writeUiReview(runDir, meta, records, { suite: s, fixturesRoot });
	const name = (arm: string, n: number) => items.find((i) => i.arm === arm && i.n === n)?.name as string;
	// bare 1 passed the verifier and looks right; bare 2 failed it and looks right (a disagreement);
	// anchorloop 1 passed and looks wrong (another); anchorloop 2 has no shot and is left unpicked.
	const answer = `User reviewed "x":\nPicked: ${name("bare", 1)} (第 1 題)\nPicked: ${name("bare", 2)} (第 1 題)\n- ${name("anchorloop", 2)} (第 1 題): 看不出來\n`;
	const labels = join(runDir, "labels.jsonl");
	const rows = applyUiAnswer(runDir, meta, answer, labels, "2026-11-27T00:00:00.000Z");
	assert.equal(rows.length, 4);
	assert.ok(rows.every((r) => r.evaluation_name === "ui_outcome" && r.source === "experiment" && r.project === "exp:ui1"));
	assert.equal(rows.find((r) => r.item === "t1/bare/1")?.session_id, "sess-bare-1");
	const ui = uiSummary(meta, records, labels, { resamples: 200 });
	assert.ok(ui);
	assert.deepEqual(ui.arms.map((a) => [a.arm, a.correct, a.labelled, `${a.shotsOk}/${a.shots}`]), [["bare", 1, 2, "2/2"], ["anchorloop", 0, 1, "1/2"]]);
	assert.equal(ui.agree, 1);
	assert.deepEqual(ui.disagree.sort(), ["t1/anchorloop/1", "t1/bare/2"]);
	assert.equal(ui.unclear, 1);
	const text = show({ ...meta, model: "m", thinking: "t", startedAt: "x" } as RunMeta, summarize(records, ["bare", "anchorloop"], { resamples: 50 }), records, [], ui);
	assert.match(text, /ui correct \(boss\)\s+100% n2\s+0% n1\s+-100 pp/);
	assert.match(text, /screenshots ok\s+2\/2\s+1\/2/);
	assert.match(text, /verifier vs boss: 1 agree \/ 2 disagree, 1 unclear/);
});
