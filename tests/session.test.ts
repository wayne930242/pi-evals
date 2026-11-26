import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionReader } from "../src/extract/session.ts";
import { setKnownProjects } from "../src/project.ts";
import { assistant, call, childSession, result, richSession, sessionLines, user } from "./fixtures.ts";

const HOME = "/home/tester";
setKnownProjects(["demo-repo", "demo"]);

function read(path: string, lines: string) {
	const reader = new SessionReader(path, HOME);
	for (const line of lines.split("\n")) reader.feedLine(line);
	const out = reader.finish();
	return { ...out, records: reader.records };
}

test("a session yields OTel-named records, one trace per prompt, and a day-bucketed summary", () => {
	const { summary, records, catalog } = read("/s/--x--/2026-11-24T10-00-00-000Z_01a2.jsonl", sessionLines(richSession(HOME)));
	assert.equal(summary.project, "demo-repo");
	assert.equal(summary.kind, "interactive");
	assert.deepEqual(catalog, ["coding", "unused-skill"]);
	const day = summary.days["2026-11-24"];
	assert.equal(day.sessions, 1);
	assert.equal(day.prompts, 2);
	assert.deepEqual(Object.keys(day.tools).sort(), ["MonitorCreate", "ask_user", "ask_user_question", "bash", "edit", "read", "subagent"]);
	assert.equal(day.tools.read.durSum, 12, "measured duration");
	assert.equal(day.tools.bash.durSum, 3000, "timestamp delta when durationMs is absent");
	assert.deepEqual(day.skills, { coding: 1, "agent-terse": 1, investigating: 1 });
	assert.deepEqual(day.skillTriggers, { read: 1, declared: 1, slash: 1 });
	assert.equal(day.ask.calls, 2);
	assert.equal(day.ask.cancelled, 1, "old ask_user shape");
	assert.equal(day.ask.durN, 2);
	assert.equal(day.monitors.started, 1);
	assert.deepEqual(day.monitors.statuses, { completed: 1 });
	assert.equal(day.monitors.durSum, 60_000);
	assert.deepEqual(day.subagents, { "reviewer|openai/gpt-6.2-sol": 1 });
	assert.equal(day.compactions, 1);
	assert.equal(Math.round(day.usage.cost * 100), 9);
	assert.equal(summary.spawned[0].id, "11111111-2222-4333-8444-555555555555");

	const names = new Set(records.map((r) => r.name));
	for (const name of ["pi.session", "invoke_agent", "execute_tool", "pi.skill.load", "pi.monitor", "anchorloop.close_guard.notice", "gen_ai.evaluation.result", "pi.compaction"]) assert.ok(names.has(name), name);
	const prompts = records.filter((r) => r.name === "invoke_agent");
	assert.equal(new Set(prompts.map((r) => r.trace_id)).size, 2);
	assert.equal(prompts[1].attrs["pi.prompt.origin"], "skill_command");
	assert.equal(prompts[0].attrs["gen_ai.usage.input_tokens"], 700);
	for (const r of records) {
		assert.equal(r.schema_version, 1);
		assert.equal(r.attrs["session.id"], "01a20000-0000-7000-8000-000000000001");
	}
	const readTool = records.find((r) => r.name === "execute_tool" && r.attrs["gen_ai.tool.name"] === "read");
	assert.equal(readTool?.attrs["gen_ai.skill.name"], "coding");
	assert.equal(readTool?.trace_id, prompts[0].trace_id);
});

test("process detectors run on the session and land in the summary and as evaluation records", () => {
	const { summary, records } = read("/s/a.jsonl", sessionLines(richSession(HOME)));
	assert.equal(summary.evals.anchor_before_first_edit?.label, "pass");
	assert.equal(summary.evals.check_after_last_edit?.label, "pass");
	assert.equal(summary.evals.todo_evidence?.label, "fail");
	assert.equal(summary.evals.todo_evidence?.value, 0.5);
	assert.equal(summary.evals.close_guard_quiet?.explanation, "no_passing_run");
	const evals = records.filter((r) => r.name === "gen_ai.evaluation.result");
	assert.equal(evals.length, 4);
	for (const e of evals) {
		assert.equal(e.attrs["eval.annotator_kind"], "CODE");
		assert.equal(e.attrs["eval.scope"], "session");
	}
});

test("sessions before 2026-11-23 are out of scope for detectors", () => {
	const { summary } = read("/s/a.jsonl", sessionLines(richSession(HOME, "s-old", "2026-10-02T10:00:00.000Z")));
	for (const result of Object.values(summary.evals)) assert.equal(result?.explanation, "out_of_scope_pre_3.0");
});

test("a subagent session knows its logical id and parent from its file name and brief", () => {
	const child = childSession(HOME);
	const { summary } = read(`/s/--x--/${child.file}`, sessionLines(child.spec));
	assert.equal(summary.kind, "subagent");
	assert.equal(summary.logicalId, "11111111-2222-4333-8444-555555555555");
	assert.equal(summary.parentId, "01a20000-0000-7000-8000-000000000001");
	assert.equal(summary.project, "demo-repo", "worktree maps to its repository");
	assert.equal(summary.days["2026-11-24"].subagentSessions, 1);
});

test("bash reads of a single SKILL.md count; globs and bulk listings do not", () => {
	const spec = {
		id: "s-bash",
		cwd: `${HOME}/projects/demo`,
		start: "2026-11-24T00:00:00.000Z",
		entries: (t: (s: number) => string) => [
			user(t(0), "x"),
			assistant(t(1), [call("b1", "bash", { command: "cat ~/.agents/skills/coding/SKILL.md" }), call("b2", "bash", { command: "wc -l skills/*/SKILL.md" }), call("b3", "bash", { command: "for s in a b c; do cat skills/$s/SKILL.md; done" })]),
			result(t(2), "b1", "bash", { exit: 0 }),
			result(t(2), "b2", "bash", { exit: 0 }),
			result(t(2), "b3", "bash", { exit: 0 }),
		],
	};
	const { summary } = read("/s/b.jsonl", sessionLines(spec));
	assert.deepEqual(summary.days["2026-11-24"].skills, { coding: 1 });
});

test("malformed lines are skipped", () => {
	const reader = new SessionReader("/s/c.jsonl", HOME);
	reader.feedLine('{"type":"session","id":"s-x","timestamp":"2026-11-24T00:00:00.000Z","cwd":"/tmp/x"}');
	reader.feedLine("{not json");
	reader.feedLine("");
	const { summary } = reader.finish();
	assert.equal(summary.sessionId, "s-x");
	assert.equal(summary.project, "tmp");
});

test("bash counts as a skill load only when the whole command prints one SKILL.md", async () => {
	const { skillsFromCommand } = await import("../src/skills.ts");
	assert.deepEqual(skillsFromCommand("cat ~/.agents/skills/coding/SKILL.md"), ["coding"]);
	assert.deepEqual(skillsFromCommand("sed -n '1,120p' /x/skills/inspecting/SKILL.md"), ["inspecting"]);
	assert.deepEqual(skillsFromCommand("cd /repo && head -80 skills/anchorloop/SKILL.md"), ["anchorloop"]);
	assert.deepEqual(skillsFromCommand("rg -n 'shared|SKILL.md' scripts/sync.py"), []);
	assert.deepEqual(skillsFromCommand("grep -n x skills/a/SKILL.md | head"), []);
	assert.deepEqual(skillsFromCommand("sed -i 's/a/b/' skills/a/SKILL.md"), []);
});

test("out-of-scope sessions do not add to the per-day detector counts", () => {
	const { summary } = read("/s/a.jsonl", sessionLines(richSession(HOME, "s-old2", "2026-10-02T10:00:00.000Z")));
	assert.deepEqual(summary.days["2026-10-02"].detectors, {});
});
