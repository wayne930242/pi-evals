/** The analysis scripts (0.7.0) on a fixture state dir built by a real extract of synthetic sessions. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadCheckpoint, saveCheckpoint } from "../src/extract/run.ts";
import { runExtract } from "../src/ops.ts";
import { layout } from "../src/paths.ts";
import { assistant, call, result, richSession, SECRET, SECRET_TOKEN, type SessionSpec, todo, user, writeAgentDir } from "./fixtures.ts";

const SB_MAIN = "01a20000-0000-7000-8000-0000000000m1";

/** A coordinator main that plans with no graph: its prompt holds the planted secret too. */
function mainSession(home: string): SessionSpec {
	return {
		id: SB_MAIN,
		cwd: join(home, "projects", "demo-repo"),
		start: "2026-11-24T12:00:00.000Z",
		entries: (t) => [
			{ type: "message", timestamp: t(0), message: { role: "system", content: [], sections: { "straw-boss": `<straw-boss>\nYou are the main agent of Herdr tab 4 x, of kind coordinator: ${SECRET}\n</straw-boss>` } } },
			user(t(1), `Plan it. ${SECRET}`),
			assistant(t(2), [call("p1", "todo", { action: "create", subject: SECRET })]),
			todo(t(3), [{ id: 1, subject: SECRET, status: "pending" }]),
			result(t(3), "p1", "todo", { text: SECRET, details: { action: "create", tasks: [{ id: 1, subject: SECRET, status: "pending" }] } }),
		],
	};
}

let built: { dir: string; state: string; ids: string[] } | undefined;
async function fixture() {
	if (built) return built;
	const dir = mkdtempSync(join(tmpdir(), "pi-evals-analysis-"));
	const ids = ["01a20000-0000-7000-8000-0000000000a1", "01a20000-0000-7000-8000-0000000000a2", "01a20000-0000-7000-8000-0000000000a3"];
	const agent = writeAgentDir(
		[
			...ids.map((id, i) => ({ dir: `--p${i % 2}--`, file: `2026-11-24T1${i}-00-00-000Z_${id}.jsonl`, spec: richSession(dir, id, `2026-11-24T1${i}:00:00.000Z`) })),
			{ dir: "--p0--", file: `2026-11-24T12-00-00-000Z_${SB_MAIN}.jsonl`, spec: mainSession(dir) },
		],
		join(dir, "agent"),
	);
	const state = join(dir, "state");
	mkdirSync(join(dir, "config", "pi-evals"), { recursive: true });
	writeFileSync(join(dir, "config", "pi-evals", "settings.json"), JSON.stringify({ changeRepos: [] }));
	await runExtract({ env: { HOME: dir, PI_CODING_AGENT_DIR: agent, PI_EVALS_STATE_DIR: state, XDG_CONFIG_HOME: join(dir, "config") }, workers: 0 });
	writeFileSync(join(state, "changes.jsonl"), [
		{ at: "2026-11-20T00:00:00.000Z", kind: "pin", subject: "x", package: "pi-anchorloop", from: "3.0.0", to: "3.2.0", source: "git", sha: "b" },
		{ at: "2026-11-24T10:30:00.000Z", kind: "pin", subject: "x", package: "pi-anchorloop", from: "3.2.0", to: "3.3.0", source: "git", sha: "a" },
	].map((c) => `${JSON.stringify(c)}\n`).join(""));
	const row = (session_id: string, label: string, extra: Record<string, unknown> = {}) => JSON.stringify({ session_id, evaluation_name: "anchor_before_first_edit", label, at: "2026-11-25T00:00:00.000Z", annotator: "human", note: SECRET, ...extra });
	// a1 agrees; a2 is a code pass the user failed; a3 was failed, then rechecked to pass (agrees).
	writeFileSync(join(state, "labels.jsonl"), [row(ids[0], "pass"), row(ids[1], "fail"), row(ids[2], "fail"), row(ids[2], "pass", { source: "recheck", at: "2026-11-26T00:00:00.000Z" })].join("\n") + "\n");
	cpSync("scripts", join(dir, "scripts"), { recursive: true });
	symlinkSync(new URL("../src", import.meta.url), join(dir, "src"));
	built = { dir, state, ids };
	return built;
}

function invoke(script: string, args: string[], extra: Record<string, string> = {}) {
	const { dir, state } = built!;
	const r = spawnSync(process.execPath, [join(dir, `scripts/${script}.mjs`), ...args], { env: { ...process.env, PI_EVALS_STATE_DIR: state, ...extra }, encoding: "utf8" });
	const out = r.stdout + r.stderr;
	assert.ok(!out.includes(SECRET) && !out.includes(SECRET_TOKEN), `${script} printed session or label text`);
	return { status: r.status, out };
}

test("freshness: extract time, version and summaries per extractor version; exit 1 when they are mixed", async () => {
	const { state } = await fixture();
	const ok = invoke("freshness", []);
	assert.equal(ok.status, 0, ok.out);
	assert.match(ok.out, /last extract 20\d\d-/);
	assert.match(ok.out, /extractor 6: 4 summaries/);
	const lay = layout(state);
	const cp = loadCheckpoint(lay.checkpoint);
	const first = Object.values(cp.files)[0];
	const saved = first.extractor;
	first.extractor = 5;
	saveCheckpoint(lay.checkpoint, cp);
	try {
		const mixed = invoke("freshness", []);
		assert.equal(mixed.status, 1);
		assert.match(mixed.out, /extractor 5: 1 summar/);
		assert.match(mixed.out, /stale/i);
	} finally {
		first.extractor = saved;
		saveCheckpoint(lay.checkpoint, cp);
	}
});

test("disagree: each labelled session with the latest human verdict, code verdict and reason, and which way they lean", async () => {
	const { ids } = await fixture();
	const r = invoke("disagree", ["anchor_before_first_edit"]);
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /3 labelled, 2 agree, 1 disagree/);
	assert.ok(r.out.includes(`${ids[1]} human fail, code pass (anchor_first), after`));
	assert.ok(!r.out.includes(`${ids[0]} human`), "agreeing sessions are not listed");
	assert.match(r.out, /code pass \/ human fail: 1/);
	assert.match(r.out, /overcounts/);
	assert.notEqual(invoke("disagree", ["no_such_rule"]).status, 0);
});

test("by-version: pass rate and n per package version at session start", async () => {
	await fixture();
	const r = invoke("by-version", ["anchor_before_first_edit"]);
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /pi-anchorloop/);
	assert.match(r.out, /3\.2\.0: 1\/1/);
	assert.match(r.out, /3\.3\.0: 2\/2/);
	const sb = invoke("by-version", ["plan_names_graph", "--pkg", "pi-straw-boss"]);
	assert.match(sb.out, /unknown: 0\/1/);
});

test("sample: a seeded stratified sample of unlabelled judged sessions, ids and metadata only, under <state>/labels", async () => {
	const { state, ids } = await fixture();
	const r = invoke("sample", ["2", "--seed", "7", "--since", "2026-11-24T00:00:00.000Z"]);
	assert.equal(r.status, 0, r.out);
	const dir = join(state, "labels");
	const file = readdirSync(dir).find((f) => /^sample-\d{4}-\d{2}-\d{2}\.json$/.test(f));
	assert.ok(file);
	const rows = JSON.parse(readFileSync(join(dir, file!), "utf8"));
	assert.equal(rows.length, 1, "three of four judged sessions are labelled already; only one remains");
	assert.deepEqual(Object.keys(rows[0]).sort(), ["kind", "model", "n", "project", "session_id", "size", "start", "tool_calls"]);
	assert.ok(!ids.includes(rows[0].session_id));
	assert.ok(!readFileSync(join(dir, file!), "utf8").includes(SECRET));
});

test("label-import: form answers become after-the-fact human rows; notes stay out of the output", async () => {
	const { state, ids, dir } = await fixture();
	const sample = join(dir, "sample-import.json");
	writeFileSync(sample, JSON.stringify([{ n: 1, session_id: ids[1] }, { n: 2, session_id: SB_MAIN }]));
	const answer = join(dir, "answer.txt");
	writeFileSync(answer, `User submitted a form:\n- 1_anchor_before_first_edit: pass\n- 1_note: ${SECRET}\n- 2_plan_names_graph: fail\n- 2_type: skipped_rule\n- 3_anchor_before_first_edit: pass\nOther comments: ${SECRET}\n`);
	const before = readFileSync(join(state, "labels.jsonl"), "utf8");
	const r = invoke("label-import", [answer, "--sample", sample]);
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /2 labels/);
	assert.match(r.out, /no session #3/);
	const added = readFileSync(join(state, "labels.jsonl"), "utf8").slice(before.length).trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(added.map((x) => [x.session_id, x.evaluation_name, x.label, x.source, x.annotator]), [[ids[1], "anchor_before_first_edit", "pass", "batch", "human"], [SB_MAIN, "plan_names_graph", "fail", "batch", "human"]]);
	assert.equal(added[0].note, SECRET);
	assert.equal(added[1].type, "skipped_rule");
	writeFileSync(join(state, "labels.jsonl"), before);
});

test("session-shape: the ordered structural trace the detectors see, with no message text", async () => {
	const { ids } = await fixture();
	const r = invoke("session-shape", [ids[0]]);
	assert.equal(r.status, 0, r.out);
	for (const want of [/anchor stated/, /edit src\/a\.ts ok/, /bash check exit=0/, /todo .*1 in_progress/, /evidence pass/, /close-guard no_passing_run/, /anchor_before_first_edit: pass \(anchor_first\)/]) assert.match(r.out, want);
	const lines = r.out.split("\n");
	assert.ok(lines.findIndex((l) => /anchor stated/.test(l)) < lines.findIndex((l) => /edit src/.test(l)), "in file order");
	assert.match(invoke("session-shape", [SB_MAIN]).out, /sb kind coordinator/);
	assert.notEqual(invoke("session-shape", ["01a20000-0000-7000-8000-00000000dead"]).status, 0);
});

test("long output goes to a file under the state dir, and the reply names it", async () => {
	const { state, ids } = await fixture();
	const r = invoke("session-shape", [ids[0]], { PI_EVALS_SCRIPT_MAX: "300" });
	assert.equal(r.status, 0, r.out);
	const path = /full output: (\S+)/.exec(r.out)?.[1];
	assert.ok(path && path.startsWith(join(state, "runs")) && existsSync(path));
	assert.ok(Buffer.byteLength(r.out) < 800);
});
