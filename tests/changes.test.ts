import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classifyPath, gitChanges, liveChanges, pinChanges, versionAt } from "../src/changes.ts";
import { record } from "../src/schema.ts";

test("pin diffs become package version changes", () => {
	const diff = [
		'-    "npm:pi-loop-monitor@0.2.7",',
		'+    "npm:pi-loop-monitor@0.2.8",',
		'-    "npm:@pify/memory@0.14.0",',
		'+    "npm:@pify/memory@0.14.1",',
		'+    "npm:pi-evals@0.1.0",',
		'-    "npm:pi-session-doctor@0.1.0",',
		'-HERDR = "git:github.com/wayne930242/pi-herdr-agents@189b0911933012f254c7cade8e367144ff82da5e"',
		'+HERDR = "git:github.com/wayne930242/pi-herdr-agents@aaaaaaa1933012f254c7cade8e367144ff82da5e"',
	].join("\n");
	const changes = pinChanges(diff);
	assert.deepEqual(changes.find((c) => c.package === "pi-loop-monitor"), { package: "pi-loop-monitor", from: "0.2.7", to: "0.2.8" });
	assert.deepEqual(changes.find((c) => c.package === "@pify/memory"), { package: "@pify/memory", from: "0.14.0", to: "0.14.1" });
	assert.deepEqual(changes.find((c) => c.package === "pi-evals"), { package: "pi-evals", from: undefined, to: "0.1.0" });
	assert.deepEqual(changes.find((c) => c.package === "pi-session-doctor"), { package: "pi-session-doctor", from: "0.1.0" });
	assert.deepEqual(changes.find((c) => c.package === "pi-herdr-agents"), { package: "pi-herdr-agents", from: "189b091", to: "aaaaaaa" });
});

test("paths map to change kinds", () => {
	assert.equal(classifyPath("scripts/pi_root/pins.py"), "pin");
	assert.equal(classifyPath("pi/herdr-agents-models.json"), "model-routing");
	assert.equal(classifyPath("rules/shell.md"), "rule");
	assert.equal(classifyPath("pi/AGENTS.md.in"), "rule");
	assert.equal(classifyPath("agents/worker.md"), "agent-role");
	assert.equal(classifyPath("skills/x/SKILL.md"), "skill");
	assert.equal(classifyPath("tests/test_x.py"), undefined);
});

test("git history yields pin and path changes, read-only", () => {
	const repo = mkdtempSync(join(tmpdir(), "pi-evals-git-"));
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env: { ...process.env, GIT_AUTHOR_DATE: "2026-11-20T10:00:00Z", GIT_COMMITTER_DATE: "2026-11-20T10:00:00Z" } });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	mkdirSync(join(repo, "scripts", "pi_root"), { recursive: true });
	mkdirSync(join(repo, "rules"));
	writeFileSync(join(repo, "scripts", "pi_root", "pins.py"), 'P = ["npm:pi-anchorloop@3.2.0"]\n');
	git("add", "scripts/pi_root/pins.py");
	git("commit", "-q", "-m", "pin anchorloop 3.2.0");
	writeFileSync(join(repo, "scripts", "pi_root", "pins.py"), 'P = ["npm:pi-anchorloop@3.3.0"]\n');
	writeFileSync(join(repo, "rules", "a.md"), "rule\n");
	git("add", "scripts/pi_root/pins.py", "rules/a.md");
	git("commit", "-q", "-m", "anchorloop 3.3.0 and a rule");
	const changes = gitChanges(repo).sort((a, b) => (a.kind + (a.to ?? "")).localeCompare(b.kind + (b.to ?? "")));
	assert.deepEqual(
		changes.map((c) => [c.kind, c.package ?? null, c.from ?? null, c.to ?? null]),
		[
			["pin", "pi-anchorloop", null, "3.2.0"],
			["pin", "pi-anchorloop", "3.2.0", "3.3.0"],
			["rule", null, null, null],
		],
	);
	assert.equal(versionAt([...changes].sort((a, b) => a.at.localeCompare(b.at)), "pi-anchorloop", "2026-11-25T00:00:00.000Z"), "3.3.0");
	assert.deepEqual(gitChanges(join(repo, "missing")), []);
});

test("live snapshots yield version changes between sessions", () => {
	const snap = (ts: string, tools: string[]) => record({ name: "pi.tools.snapshot", kind: "event", ts, source: "live", attrs: { "pi.tools": tools } });
	const changes = liveChanges([snap("2026-11-25T00:00:00.000Z", ["todo=pi-todo-ledger@0.2.0", "read=pi:builtin"]), snap("2026-11-26T00:00:00.000Z", ["todo=pi-todo-ledger@0.3.0", "read=pi:builtin"])]);
	assert.deepEqual(changes.map((c) => [c.package, c.from, c.to, c.source]), [["pi-todo-ledger", "0.2.0", "0.3.0", "live"]]);
});
