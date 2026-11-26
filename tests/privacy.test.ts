import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mark, runExtract, runReport, statusText } from "../src/ops.ts";
import { setKnownProjects } from "../src/project.ts";
import { query, VIEWS } from "../src/query.ts";
import { assistant, call, childSession, richSession, result, SECRET, SECRET_TOKEN, user, writeAgentDir } from "./fixtures.ts";

function allFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? allFiles(path) : [path];
	});
}

test("a secret planted in every text field of a session reaches no output file and no query result", async () => {
	const home = mkdtempSync(join(tmpdir(), "pi-evals-home-"));
	setKnownProjects(["demo-repo"]);
	const rich = richSession(home);
	// A model-chosen path and tool name that carry the secret: names, but not name-shaped.
	const odd = {
		id: "01a20000-0000-7000-8000-0000000000d1",
		cwd: join(home, "projects", "demo-repo"),
		start: "2026-11-25T09:00:00.000Z",
		entries: (t: (s: number) => string) => [
			user(t(0), SECRET),
			assistant(t(1), [call("o1", "read", { path: `/x/${SECRET}/SKILL.md` }), call("o2", `tool ${SECRET}`, { a: SECRET }), call("o3", "subagent", { agent: SECRET, model: SECRET })], 0.01, `model ${SECRET}`),
			result(t(2), "o1", "read", { durationMs: 1 }),
			result(t(2), "o2", `tool ${SECRET}`, { isError: true }),
			result(t(3), "o3", "subagent", { details: { id: "99999999-2222-4333-8444-555555555555", agent: SECRET, model: SECRET } }),
		],
	};
	const child = childSession(home);
	const agentDir = writeAgentDir([
		{ dir: "--demo--", file: "2026-11-24T10-00-00-000Z_01a20000-0000-7000-8000-000000000001.jsonl", spec: rich },
		{ dir: "--demo--", file: "2026-11-25T09-00-00-000Z_01a20000-0000-7000-8000-0000000000d1.jsonl", spec: odd },
		{ dir: "--demo-wt--", file: child.file, spec: child.spec },
	]);
	const state = join(home, "state");
	const config = join(home, "config");
	mkdirSync(join(config, "pi-evals"), { recursive: true });
	writeFileSync(join(config, "pi-evals", "settings.json"), JSON.stringify({ changeRepos: [] }));
	const env = { HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_EVALS_STATE_DIR: state, XDG_CONFIG_HOME: config };

	const status = await runExtract({ env, workers: 0 });
	assert.equal(status.stats.failed, 0);
	assert.equal(status.sessions.backfill, 3);
	const report = runReport({ env, outDir: join(state, "reports") });
	assert.ok(report);
	runReport({ env, outDir: join(state, "reports-en"), lang: "en" });
	const outputs = [statusText(env), ...VIEWS.map((view) => query(view, { env }))];

	const leaks = allFiles(state).filter((file) => {
		const text = readFileSync(file, "utf8");
		return text.includes(SECRET) || text.includes(SECRET_TOKEN) || text.includes("PLANTED");
	});
	assert.deepEqual(leaks, [], `secret found in ${leaks.join(", ")}`);
	for (const out of outputs) assert.ok(!out.includes("PLANTED"), "secret in a query or status result");
	// The data is still there, by name.
	assert.match(readFileSync(report.json, "utf8"), /"coding"/);
	mark("pinned pi-x 1.2", env);
});
