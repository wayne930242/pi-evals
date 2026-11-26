import assert from "node:assert/strict";
import { test } from "node:test";
import { type DetectorName, noticeKind, ProcessTracker } from "../src/detectors.ts";

let n = 0;
const assistant = (...content: unknown[]) => ({ type: "message", id: `e${++n}`, message: { role: "assistant", content } });
const text = (t: string) => ({ type: "text", text: t });
const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ type: "toolCall", id, name, arguments: args });
const result = (id: string, opts: { isError?: boolean; exit?: number } = {}) => ({
	type: "message",
	id: `e${++n}`,
	message: { role: "toolResult", toolCallId: id, isError: opts.isError ?? false, ...(opts.exit === undefined ? {} : { structuredContent: { exit_code: opts.exit } }) },
});
const todo = (tasks: unknown[]) => ({ type: "custom", customType: "todo/v1", data: { v: 1, nextId: 9, tasks } });
const notice = (content: string) => ({ type: "custom_message", customType: "anchorloop-close-guard", content });

function run(entries: unknown[], inScope = true) {
	const tracker = new ProcessTracker();
	for (const entry of entries) tracker.feed(entry);
	return Object.fromEntries(tracker.results(inScope).map((r) => [r.name, r])) as unknown as Record<DetectorName, { label: string; value?: number; explanation: string }>;
}

const edit = (id: string) => [assistant(call(id, "edit", { path: "a.ts" })), result(id)];
const bash = (id: string, command: string, exit: number) => [assistant(call(id, "bash", { command })), result(id, { exit, isError: exit !== 0 })];

test("anchor before first edit: pass when the Anchor line precedes the first change", () => {
	const r = run([assistant(text("Plan.\nAnchor: `npm test`")), ...edit("c1"), ...bash("b1", "npm test", 0)]);
	assert.equal(r.anchor_before_first_edit.label, "pass");
});

test("anchor before first edit: fail when the anchor comes only after the first change", () => {
	const r = run([...edit("c1"), assistant(text("Anchor: `npm test`")), ...edit("c2")]);
	assert.equal(r.anchor_before_first_edit.label, "fail");
	assert.equal(r.anchor_before_first_edit.explanation, "change_before_anchor");
});

test("anchor before first edit: a todo anchor counts, a failed edit is no change, no change is na", () => {
	assert.equal(run([assistant(call("t1", "todo", { action: "create", subject: "x", anchor: "npm test" })), result("t1"), ...edit("c1")]).anchor_before_first_edit.label, "pass");
	const failedEdit = run([assistant(call("c0", "edit")), result("c0", { isError: true }), assistant(text("Anchor: `npm test`")), ...edit("c1")]);
	assert.equal(failedEdit.anchor_before_first_edit.label, "pass");
	assert.equal(run([...bash("b1", "ls", 0)]).anchor_before_first_edit.label, "na");
});

test("check after last edit: pass when every anchor command passed after the last change", () => {
	const r = run([assistant(text("Anchor: `npm run check` and `npm test`")), ...edit("c1"), ...bash("b1", "npm run check", 0), ...bash("b2", "cd x && npm test", 0)]);
	assert.equal(r.check_after_last_edit.label, "pass");
});

test("check after last edit: fail when the latest run failed or ran before the last change", () => {
	assert.equal(run([assistant(text("Anchor: `npm test`")), ...edit("c1"), ...bash("b1", "npm test", 1)]).check_after_last_edit.label, "fail");
	const stale = run([assistant(text("Anchor: `npm test`")), ...edit("c1"), ...bash("b1", "npm test", 0), ...edit("c2")]);
	assert.equal(stale.check_after_last_edit.label, "fail");
	assert.equal(stale.check_after_last_edit.explanation, "no_passing_run_after_change");
});

test("check after last edit: no anchor and no check after the change is a fail; a check-less anchor stays na", () => {
	const none = run([...edit("c1")]).check_after_last_edit;
	assert.equal(none.label, "fail");
	assert.equal(none.explanation, "no_check_after_change");
	assert.equal(run([assistant(text("Anchor: the reviewer approves")), ...edit("c1")]).check_after_last_edit.explanation, "anchor_without_command");
});

test("todo evidence: share of completed tasks carrying evidence, from the newest snapshot", () => {
	const r = run([
		todo([{ id: 1, subject: "a", status: "completed" }]),
		todo([
			{ id: 1, subject: "a", status: "completed", evidence: [{ command: "npm test", result: "pass", at: "x" }] },
			{ id: 2, subject: "b", status: "completed" },
			{ id: 3, subject: "c", status: "pending" },
		]),
	]);
	assert.equal(r.todo_evidence.label, "fail");
	assert.equal(r.todo_evidence.value, 0.5);
	const all = run([todo([{ id: 1, subject: "a", status: "completed", evidence: [{ command: "x", result: "pass" }] }])]);
	assert.equal(all.todo_evidence.label, "pass");
	assert.equal(run([todo([{ id: 1, subject: "a", status: "pending" }])]).todo_evidence.label, "na");
});

test("close guard quiet: fail with the commonest notice kind, pass with none, na without a change", () => {
	const noisy = run([...edit("c1"), notice("anchorloop: files changed, but no `Anchor: <check>` line was stated; state it.")]);
	assert.equal(noisy.close_guard_quiet.label, "fail");
	assert.equal(noisy.close_guard_quiet.explanation, "no_anchor");
	assert.equal(run([assistant(text("Anchor: `x`")), ...edit("c1"), ...bash("b", "x", 0)]).close_guard_quiet.label, "pass");
	assert.equal(run([...bash("b", "x", 0)]).close_guard_quiet.label, "na");
});

test("notice kinds", () => {
	assert.equal(noticeKind("anchorloop: files changed, but no `Anchor: <check>` line was stated; state the check."), "no_anchor");
	assert.equal(noticeKind("anchorloop: no passing run of `npm test` after the last change."), "no_passing_run");
	assert.equal(noticeKind("anchorloop: use todo update on #3 to append each unrecorded passing run to evidence"), "evidence_handoff");
	assert.equal(noticeKind("something else"), "other");
});

test("sessions before anchorloop 3.0.0 are out of scope, not failures", () => {
	const r = run([...edit("c1")], false);
	for (const name of ["anchor_before_first_edit", "check_after_last_edit", "todo_evidence", "close_guard_quiet"] as const) {
		assert.equal(r[name].label, "na");
		assert.equal(r[name].explanation, "out_of_scope_pre_3.0");
	}
});

test("close guard quiet: an evidence hand-off reminder alone is not a failure", () => {
	const r = run([assistant(text("Anchor: `x`")), ...edit("c1"), ...bash("b", "x", 0), notice("anchorloop: use todo update on #2 to append each unrecorded passing run to evidence")]);
	assert.equal(r.close_guard_quiet.label, "pass");
});

const user = (t: string) => ({ type: "message", id: `u${++n}`, message: { role: "user", content: [{ type: "text", text: t }] } });
const monitor = (id: string, command: string, monitorId: string) => [
	assistant(call(id, "MonitorCreate", { command, description: "x" })),
	{ type: "message", id: `e${++n}`, message: { role: "toolResult", toolCallId: id, isError: false, content: [{ type: "text", text: `Monitor #${monitorId} started: x` }] } },
];
const monitorDone = (monitorId: string, exitCode: number) => ({
	type: "custom_message",
	customType: "pi-loop-monitor",
	content: "[pi-loop-monitor] Loop #1 fired (event: monitor:done).",
	details: { monitorOutcome: { monitorId, status: exitCode === 0 ? "completed" : "error", exitCode } },
});
const evidence = (id: string, verdict: "pass" | "fail") => [assistant(call(id, "todo", { action: "update", id: 1, evidence: [{ command: "x", result: verdict }] })), result(id)];
const editAt = (id: string, path: string) => [assistant(call(id, "edit", { path })), result(id)];

test("anchor before first edit: an Anchor in the brief counts, as the worker's anchor", () => {
	const r = run([user("Do it.\nAnchor: `npm test`"), ...edit("c1"), ...bash("b1", "npm test", 0)]);
	assert.equal(r.anchor_before_first_edit.label, "pass");
	assert.equal(r.anchor_before_first_edit.explanation, "anchor_in_brief");
	assert.equal(r.check_after_last_edit.explanation, "anchor_green");
});

test("anchor before first edit: a brief's Gates or Checks line, or a check command it names, counts", () => {
	assert.equal(run([user("Fix it.\nGates: backend tests, frontend tsc + eslint."), ...edit("c1")]).anchor_before_first_edit.label, "pass");
	assert.equal(run([user("Fix it.\nChecks: touched tests, web tsc, pnpm lint."), ...edit("c1")]).anchor_before_first_edit.label, "pass");
	assert.equal(run([user("Goal: mockups. SVG frames, measure.mjs to `defects 0`, render PNGs."), ...edit("c1")]).anchor_before_first_edit.label, "pass");
	assert.equal(run([user("Please tidy the README wording."), ...edit("c1")]).anchor_before_first_edit.label, "fail");
});

test("anchor before first edit: a labelled check line in the agent's own words counts, in either colon", () => {
	assert.equal(run([assistant(text("計畫如下。\n**驗證：** `npm test`")), ...edit("c1")]).anchor_before_first_edit.label, "pass");
	assert.equal(run([assistant(text("Plan.\nVerify: `npm run check`")), ...edit("c1")]).anchor_before_first_edit.label, "pass");
	assert.equal(run([assistant(text("I will check the tests later.")), ...edit("c1")]).anchor_before_first_edit.label, "fail");
});

test("anchor before first edit: a todo's sb check spec counts", () => {
	const spec = { sb: { v: 1, spec: { check: { type: "run", run: "bash gates.sh" } } } };
	const r = run([assistant(call("t1", "todo", { action: "create", subject: "gates", metadata: spec })), result("t1"), ...edit("c1")]);
	assert.equal(r.anchor_before_first_edit.label, "pass");
});

test("anchor before first edit: a first change to a test file is the anchor (red first)", () => {
	for (const path of ["tests/a.test.ts", "apps/web/src/x.spec.tsx", "pkg/foo_test.go", "tests/Api.Tests/UserEndpointTests.cs", "tests/test_hints.py"]) {
		const r = run([...editAt("c1", path), ...editAt("c2", "src/a.ts")]);
		assert.equal(r.anchor_before_first_edit.label, "pass", path);
		assert.equal(r.anchor_before_first_edit.explanation, "test_first");
	}
	assert.equal(run([...editAt("c1", "src/a.ts"), ...editAt("c2", "tests/a.test.ts")]).anchor_before_first_edit.label, "fail");
	assert.equal(run([...editAt("c1", "src/latest.ts")]).anchor_before_first_edit.label, "fail");
});

test("check after last edit: an anchor command run in a monitor counts by its exit code", () => {
	const head = [assistant(text("Anchor: `npm run check` and `npm test`")), ...edit("c1")];
	const green = run([...head, ...monitor("m1", "npm run check && npm test", "3"), monitorDone("3", 0)]);
	assert.equal(green.check_after_last_edit.label, "pass");
	assert.equal(green.check_after_last_edit.explanation, "anchor_green");
	assert.equal(run([...head, ...monitor("m1", "npm run check && npm test", "3"), monitorDone("3", 1)]).check_after_last_edit.label, "fail");
	assert.equal(run([...head, ...monitor("m1", "npm run check && npm test", "3")]).check_after_last_edit.label, "fail");
});

test("check after last edit: passing evidence the agent recorded after the last change counts", () => {
	const prose = assistant(call("t0", "todo", { action: "create", subject: "x", anchor: "blog tests + tsc" }));
	const after = run([prose, result("t0"), ...edit("c1"), ...evidence("t1", "pass")]);
	assert.equal(after.check_after_last_edit.label, "pass");
	assert.equal(after.check_after_last_edit.explanation, "evidence_after_change");
	assert.equal(run([prose, result("t0"), ...evidence("t1", "pass"), ...edit("c1")]).check_after_last_edit.label, "fail");
	assert.equal(run([prose, result("t0"), ...edit("c1"), ...evidence("t1", "fail")]).check_after_last_edit.label, "fail");
});

test("check after last edit: a test, build or type-check run after the last change counts when the anchor names none that ran", () => {
	const noAnchor = run([...edit("c1"), ...bash("b1", "cd apps/web && npx tsc --noEmit -p .", 0)]);
	assert.equal(noAnchor.check_after_last_edit.label, "pass");
	assert.equal(noAnchor.check_after_last_edit.explanation, "check_run_after_change");
	const prose = assistant(call("t0", "todo", { action: "create", subject: "x", anchor: "vitest for rail + web tsc" }));
	assert.equal(run([prose, result("t0"), ...edit("c1"), ...bash("b1", "CI=1 bunx vitest run tests/unit", 0)]).check_after_last_edit.label, "pass");
	assert.equal(run([...edit("c1"), ...bash("b1", "python3 -I tests/overlay.py 2>&1 | tail -2", 0)]).check_after_last_edit.label, "pass");
	assert.equal(run([...edit("c1"), ...bash("b1", "rg -l x; A=1 uv run --no-project python scripts/dev/dotnet-local.py test 05.Tests/X -c Release", 0)]).check_after_last_edit.label, "pass");
	assert.equal(run([...edit("c1"), ...monitor("m1", "cd w && bash .logs/fu-checks.sh 2>&1 | grep -E '^==='", "2"), monitorDone("2", 0)]).check_after_last_edit.label, "pass");
	assert.equal(run([...edit("c1"), ...bash("b1", "npm test", 1)]).check_after_last_edit.explanation, "no_passing_run_after_change");
});

test("check after last edit: a failing anchor run is not rescued by another check", () => {
	const r = run([assistant(text("Anchor: `npm test`")), ...edit("c1"), ...bash("b1", "npm test", 1), ...bash("b2", "npx tsc --noEmit", 0)]);
	assert.equal(r.check_after_last_edit.label, "fail");
	assert.equal(r.check_after_last_edit.explanation, "no_passing_run_after_change");
});

test("check after last edit: prose written after the check does not undo it; a prose-only session has no runnable check", () => {
	const r = run([assistant(text("Anchor: `npm test`")), ...editAt("c1", "src/a.ts"), ...bash("b1", "npm test", 0), ...editAt("c2", "CHANGELOG.md"), ...editAt("c3", "scratch/report.md")]);
	assert.equal(r.check_after_last_edit.label, "pass");
	const code = run([assistant(text("Anchor: `npm test`")), ...editAt("c1", "src/a.ts"), ...bash("b1", "npm test", 0), ...editAt("c2", "src/b.ts")]);
	assert.equal(code.check_after_last_edit.label, "fail");
	const prose = run([user("Review the diff and write scratch/review.md."), ...editAt("c1", "scratch/review.md")]);
	assert.equal(prose.check_after_last_edit.label, "na");
	assert.equal(prose.check_after_last_edit.explanation, "prose_only");
});

// Held-out guard: the shapes of five real sessions (2026-11-25/26) that edited and ran no check at all, which the
// 0.5.0 detectors failed. Only their structure is kept (tool order, file kinds, command shapes); every text is made up.
const guardSet: Record<string, unknown[]> = {
	"code edit, then git add and commit": [
		user("Complete your task autonomously. Backport the fix onto main in this worktree and commit it."),
		...bash("g1", "cd /w && git status --short && git log --oneline -3", 0),
		...bash("g2", "cd /w && git show abc123 --stat", 0),
		...bash("g3", "cd /w && git ls-tree origin/main src/Repos/", 0),
		...bash("g4", "cd /w && git rm -q --cached src/Repos/Old.cs", 0),
		...editAt("c1", "/w/src/Repos/OrderRepository.cs"),
		...bash("g5", "cd /w && git add src/Repos/OrderRepository.cs && git diff --cached --stat", 0),
		...bash("g6", "cd /w && git commit -q -C abc123 >| /tmp/c1.log 2>&1; echo ec=$?", 0),
	],
	"translation edits with an inline script between them": [
		user("Complete your task autonomously. Polish part 6 of the guide and record new terms."),
		...bash("g1", "rg -n 'term|other' translation/assembled/guide/06-part.md", 0),
		...bash("g2", "f=translation/assembled/guide/06-part.md; awk 'NR==10' \"$f\"", 0),
		...editAt("c1", "translation/assembled/guide/06-part.md"),
		...editAt("c2", "translation/assembled/guide/06-part.md"),
		...bash("g3", "python3 - <<'PY'\nprint(1)\nPY", 0),
		...editAt("c3", "translation/new-terms/pass2-06a.json"),
		...editAt("c4", "translation/reviews/pass2-06a.md"),
		notice("anchorloop: files changed, but no `Anchor: <check>` line was stated; state the check and show it passing."),
	],
	"many prose edits, lookups, then a terms file": [
		user("Complete your task autonomously. Translate part 3a of the gear chapter."),
		...editAt("c1", "scratch/ep/translation/parts/17-gear-p3a.md"),
		...bash("g1", "jq -r '.[]|[.en,.zh]|@tsv' scratch/ep/glossary/glossary.json | head", 0),
		...editAt("c2", "scratch/ep/translation/parts/17-gear-p3a.md"),
		...editAt("c3", "scratch/ep/translation/parts/17-gear-p3a.md"),
		...bash("g2", "pdftotext -f 334 -l 335 src/book.pdf - | head", 0),
		...editAt("c4", "scratch/ep/translation/new-terms/17-gear-p3a.json"),
		...bash("g3", "python3 -I - <<'PY'\nprint(2)\nPY", 0),
		...editAt("c5", "scratch/ep/translation/parts/17-gear-p3a.md"),
	],
	"a generator script edited and rerun, then a review page": [
		assistant(call("t1", "todo", { action: "create", subject: "Draw the icon sprite" })),
		result("t1"),
		...bash("g1", "rg -in 'plum|cream' docs/specs/theme/spec.md", 0),
		...editAt("c1", "scratch/icons/sprite/build.py"),
		...bash("g2", "python3 scratch/icons/sprite/build.py; wc -c scratch/icons/sprite/sprite.svg", 0),
		...editAt("c2", "scratch/icons/sprite/build.py"),
		...bash("g3", "python3 scratch/icons/sprite/build.py && wc -c scratch/icons/sprite/sprite.svg", 0),
		...editAt("c3", "scratch/icons/sprite/review.md"),
		assistant(call("s1", "show_doc", { paths: ["scratch/icons/sprite/review.md"] })),
		result("s1"),
		assistant(call("t2", "todo", { action: "update", id: 1, status: "completed" })),
		result("t2"),
	],
	"an image, a build script, a crop, then a review page": [
		assistant(call("t1", "todo", { action: "update", id: 2, status: "in_progress" })),
		result("t1"),
		assistant(call("i1", "codex_generate_image", { prompt: "icons" })),
		result("i1"),
		...bash("g1", "ls -l scratch/icons/kinds/*/*; python3 -c 'print(3)'", 0),
		...editAt("c1", "scratch/icons/kinds/build.py"),
		...bash("g2", "python3 scratch/icons/kinds/build.py", 0),
		...bash("g3", "magick scratch/icons/kinds/day.png -crop 762x24+0+37 +repage scratch/icons/kinds/detail.png", 0),
		...editAt("c2", "scratch/icons/kinds/build.py"),
		...bash("g4", "python3 scratch/icons/kinds/build.py && rm scratch/icons/kinds/detail.png", 0),
		...editAt("c3", "scratch/icons/kinds/review.md"),
		assistant(call("t2", "todo", { action: "update", id: 2, status: "completed" })),
		result("t2"),
	],
};

test("guard set: sessions that edited and ran no check stay fail on both rules", () => {
	for (const [shape, entries] of Object.entries(guardSet)) {
		const r = run(entries);
		assert.equal(r.anchor_before_first_edit.label, "fail", shape);
		assert.equal(r.check_after_last_edit.label, "fail", shape);
		assert.equal(r.check_after_last_edit.explanation, "no_check_after_change", shape);
	}
});

test("check after last edit: commands that only mention tests are not checks", () => {
	for (const command of ["rg -n test src", "ls tests", "git add tests/a.test.ts && git commit -m 'test: x'", "cat package.json | grep '\"test'", "git diff --stat", "sed -n 1,20p tests/a.test.ts"]) {
		const r = run([...edit("c1"), ...bash("b1", command, 0)]);
		assert.equal(r.check_after_last_edit.label, "fail", command);
		assert.equal(r.check_after_last_edit.explanation, "no_check_after_change", command);
	}
});

// plan_names_graph: structure only, no transcript text.
const mainPrompt = (kind: string) => ({ type: "message", message: { role: "system", content: [], sections: { "straw-boss": `<straw-boss>\nYou are the main agent of Herdr tab 4 a tab, of kind ${kind}: the boss works with you here.\n</straw-boss>` } } });
const standingPrompt = { type: "message", message: { role: "system", content: [], sections: { "straw-boss": "<straw-boss>\nYou are the standing main of Herdr tab 2: you mind one system.\n</straw-boss>" } } };
const RULE = "sb: your open todos name no graph. From planning.md:\n...\nSet the `graph` field on these todos.";
const todoCall = (id: string, args: Record<string, unknown>, tasks: unknown[], rule = false) => [
	assistant(call(id, "todo", args)),
	todo(tasks),
	{ type: "message", id: `e${++n}`, message: { role: "toolResult", toolCallId: id, isError: false, content: [{ type: "text", text: rule ? `Created #1\n${RULE}` : "Created #1" }], details: { action: args.action, tasks } } },
];
const plan = (extra: Record<string, unknown> = {}) => [{ id: 1, subject: "s", status: "pending", ...extra }, { id: 2, subject: "s", status: "pending" }];

test("plan names graph: a coordinator's first create with a graph passes; a legacy metadata.graph counts", () => {
	assert.deepEqual(run([mainPrompt("coordinator"), ...todoCall("t1", { action: "create" }, plan({ graph: "fan-out/fan-in" }))]).plan_names_graph, { name: "plan_names_graph", label: "pass", explanation: "graph_at_first_create" });
	assert.equal(run([standingPrompt, ...todoCall("t1", { action: "create" }, plan({ metadata: { graph: "single" } }))]).plan_names_graph.label, "pass");
	assert.equal(run([mainPrompt("coordinator"), ...todoCall("t1", { action: "create" }, plan({ graph: "pipeline" }))]).plan_names_graph.label, "fail", "a name that is no graph is none");
});

test("plan names graph: the next todo call after sb's planning rule decides", () => {
	const first = todoCall("t1", { action: "create" }, plan(), true);
	const fixed = run([mainPrompt("coordinator"), ...first, ...todoCall("t2", { action: "update", id: 1, graph: "single-loop" }, plan({ graph: "single-loop" }))]).plan_names_graph;
	assert.deepEqual([fixed.label, fixed.explanation], ["pass", "graph_after_rule"]);
	const kept = run([mainPrompt("coordinator"), ...first, ...todoCall("t2", { action: "create" }, [...plan(), { id: 3, subject: "s", status: "pending" }])]).plan_names_graph;
	assert.deepEqual([kept.label, kept.explanation], ["fail", "kept_planning_without_graph"]);
	assert.deepEqual(run([mainPrompt("coordinator"), ...first]).plan_names_graph.label, "fail", "a plan with no graph and no later todo call");
});

test("plan names graph: na for a session that is no coordinator or standing main, or that never planned", () => {
	assert.equal(run([...todoCall("t1", { action: "create" }, plan())]).plan_names_graph.explanation, "not_sb_main");
	assert.equal(run([mainPrompt("integrator"), ...todoCall("t1", { action: "create" }, plan())]).plan_names_graph.label, "na");
	assert.equal(run([mainPrompt("coordinator"), ...todoCall("t1", { action: "create" }, [{ id: 1, subject: "s", status: "completed" }])]).plan_names_graph.explanation, "no_plan");
	const steps = [{ id: 1, subject: "s", status: "pending", metadata: { sb: { kind: "train" } } }];
	assert.equal(run([mainPrompt("coordinator"), ...todoCall("t1", { action: "create" }, steps)]).plan_names_graph.explanation, "no_plan", "a train's steps are not the plan");
	assert.equal(run([mainPrompt("coordinator"), ...todoCall("t1", { action: "create" }, plan())], false).plan_names_graph.label, "fail", "the anchorloop era does not bound the sb rule");
});

test("plan names graph: the kind follows role steers and kind entries", () => {
	const steer = (name: string, duty: string) => ({ type: "custom_message", customType: "straw-boss", content: "x", details: { briefed: { name, duty } } });
	assert.equal(run([steer("main", "coordinator"), ...todoCall("t1", { action: "create" }, plan())]).plan_names_graph.label, "fail");
	assert.equal(run([mainPrompt("coordinator"), steer("member", ""), ...todoCall("t1", { action: "create" }, plan())]).plan_names_graph.label, "na");
	const toIntegrator = { type: "custom", customType: "straw-boss", data: { duty: "integrator" } };
	assert.equal(run([mainPrompt("coordinator"), toIntegrator, ...todoCall("t1", { action: "create" }, plan())]).plan_names_graph.label, "na");
});
