import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildFixture } from "../src/exp/fixture.ts";
import { loadSuite } from "../src/exp/task.ts";
import { runTrial } from "../src/exp/trial.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();

function sourceRepo() {
	const repo = mkdtempSync(join(tmpdir(), "exp-src-"));
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "t@t");
	git(repo, "config", "user.name", "t");
	writeFileSync(join(repo, "a.txt"), "base\n");
	git(repo, "add", "a.txt");
	git(repo, "commit", "-qm", "base");
	const base = git(repo, "rev-parse", "HEAD");
	writeFileSync(join(repo, "answer.txt"), "the future fix\n");
	git(repo, "add", "answer.txt");
	git(repo, "commit", "-qm", "future");
	return { repo, base, future: git(repo, "rev-parse", "HEAD") };
}

// A stand-in for pi: records what the agent could see, writes a session file, edits one file.
const FAKE_PI = `#!/bin/sh
dir=""
while [ $# -gt 0 ]; do [ "$1" = "--session-dir" ] && dir="$2"; shift; done
mkdir -p "$dir"
{ echo "seen_check=$(test -e .exp-check && echo yes || echo no)"; echo "commits=$(git log --all --oneline | wc -l | tr -d ' ')"; echo "future=$(test -e answer.txt && echo yes || echo no)"; } > marker.txt
cat > "$dir/s.jsonl" <<'EOF'
{"type":"session","version":3,"id":"s1","cwd":"x"}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"do it"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"w1","name":"write","arguments":{"path":"marker.txt"}}],"usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.5}}}}
{"type":"message","message":{"role":"toolResult","toolCallId":"w1","isError":false}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Done."}],"usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.5}}}}
EOF
echo '{"type":"agent_end"}'
`;

function suite(base: string, repo: string) {
	const root = mkdtempSync(join(tmpdir(), "exp-suite-"));
	writeFileSync(join(root, "suite.json"), JSON.stringify({ model: "m/x", thinking: "medium", forbidden: [] }));
	mkdirSync(join(root, "arms"));
	writeFileSync(join(root, "arms", "bare.json"), JSON.stringify({ extensions: [], skills: [], appendSystemPrompt: [] }));
	const task = join(root, "tasks", "t1");
	mkdirSync(join(task, "check"), { recursive: true });
	writeFileSync(join(task, "task.json"), JSON.stringify({ id: "t1", kind: "anchor", fixture: { repo, base }, reference: { patch: "reference.patch" }, timeout_min: 1 }));
	writeFileSync(join(task, "prompt.md"), "do it\n");
	writeFileSync(join(task, "check", "check.sh"), "#!/bin/sh\necho checked\ngrep -q seen_check=no marker.txt && grep -q commits=1 marker.txt && grep -q future=no marker.txt\n");
	return root;
}

test("fixture: one commit with no history, remote or future files", () => {
	const { repo, base } = sourceRepo();
	const s = loadSuite(suite(base, repo));
	const dir = buildFixture(s, s.tasks[0], mkdtempSync(join(tmpdir(), "exp-fx-")));
	assert.equal(git(dir, "log", "--all", "--oneline").split("\n").length, 1);
	assert.equal(git(dir, "remote"), "");
	assert.equal(git(dir, "reflog").split("\n").length, 1);
	assert.ok(existsSync(join(dir, "a.txt")));
	assert.ok(!existsSync(join(dir, "answer.txt")));
	// Rebuilding reuses the cached fixture.
	assert.equal(buildFixture(s, s.tasks[0], join(dir, "..")), dir);
});

test("fixture: a review task gets the base and the change under review, nothing later", () => {
	const { repo, base, future } = sourceRepo();
	const root = suite(base, repo);
	const taskFile = join(root, "tasks", "t1", "task.json");
	writeFileSync(taskFile, JSON.stringify({ ...JSON.parse(readFileSync(taskFile, "utf8")), kind: "should_not", fixture: { repo, base, review: future }, reference: { answer: "r.md" }, facts: [["x"]] }));
	const s = loadSuite(root);
	const dir = buildFixture(s, s.tasks[0], mkdtempSync(join(tmpdir(), "exp-fx-")));
	assert.equal(git(dir, "log", "--all", "--oneline").split("\n").length, 2);
	assert.ok(existsSync(join(dir, "answer.txt")));
});

test("trial: the hidden check reaches the work dir only after the agent ends; the work dir is removed", async () => {
	const { repo, base } = sourceRepo();
	const s = loadSuite(suite(base, repo));
	const fixture = buildFixture(s, s.tasks[0], mkdtempSync(join(tmpdir(), "exp-fx-")));
	const bin = join(mkdtempSync(join(tmpdir(), "exp-bin-")), "pi");
	writeFileSync(bin, FAKE_PI);
	chmodSync(bin, 0o755);
	const runDir = mkdtempSync(join(tmpdir(), "exp-run-"));
	const r = await runTrial({ suite: s, task: s.tasks[0], arm: "bare", n: 1, runDir, fixture, piBin: bin, authFile: undefined });
	const trialDir = join(runDir, "trials", "t1", "bare", "1");
	const patch = readFileSync(join(trialDir, "diff.patch"), "utf8");
	assert.match(patch, /seen_check=no/);
	assert.match(patch, /commits=1/);
	assert.match(patch, /future=no/);
	assert.match(readFileSync(join(trialDir, "check.log"), "utf8"), /checked/);
	assert.equal(r.outcome, true);
	assert.equal(r.valid, true);
	assert.equal(r.efficiency.cost, 1);
	assert.ok(!existsSync(r.workDir), "work dir removed after grading");
	assert.ok(existsSync(join(trialDir, "grade.json")));
});
