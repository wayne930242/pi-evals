import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { labConfig, paneShell, sweepProcesses, trialProcesses } from "../src/exp/herdr-lab.ts";
import { runRpc } from "../src/exp/rpc.ts";
import { summarize } from "../src/exp/summary.ts";
import { loadSuite } from "../src/exp/task.ts";
import { dispatchAgentFiles, dispatchArgs, expDispatchPath, findSession, gradeTrial, piArgs, stampMismatch } from "../src/exp/trial.ts";

function dispatchSuite(dispatch: Record<string, unknown> = {}) {
	const root = mkdtempSync(join(tmpdir(), "exp-dsuite-"));
	const host = join(root, "vendor", "pi-herdr-agents");
	mkdirSync(join(host, "pi-extension", "subagents"), { recursive: true });
	writeFileSync(join(host, "pi-extension", "subagents", "index.ts"), "export default () => {};\n");
	writeFileSync(join(root, "suite.json"), JSON.stringify({ model: "openai-codex/gpt-6.2-astra", thinking: "medium", extensions: ["ledger.ts"], dispatch: { herdrAgents: "vendor/pi-herdr-agents", ...dispatch } }));
	mkdirSync(join(root, "arms"));
	writeFileSync(join(root, "arms", "bare.json"), JSON.stringify({ extensions: [], skills: [], appendSystemPrompt: [] }));
	writeFileSync(join(root, "arms", "routed.json"), JSON.stringify({ extensions: ["guard.ts"], skills: ["skills"], appendSystemPrompt: ["one.md", "two.md"] }));
	writeFileSync(join(root, "one.md"), "Route through skills.\n");
	writeFileSync(join(root, "two.md"), "Second part.\n");
	const task = join(root, "tasks", "t1");
	mkdirSync(join(task, "check"), { recursive: true });
	writeFileSync(join(task, "task.json"), JSON.stringify({ id: "t1", kind: "anchor", fixture: { dir: "fx" }, reference: { patch: "reference.patch" }, timeout_min: 1 }));
	writeFileSync(join(task, "prompt.md"), "Launch one child.\n");
	writeFileSync(join(task, "check", "check.sh"), "exit 0\n");
	return root;
}

test("suite: dispatch is opt-in, with default caps; a missing host or a work-dir HOME task is refused", () => {
	const s = loadSuite(dispatchSuite());
	assert.deepEqual(s.dispatch, { herdrAgents: join(s.dir, "vendor", "pi-herdr-agents"), maxConcurrent: 3, maxLaunches: 8 });
	assert.equal(loadSuite(dispatchSuite({ maxConcurrent: 2 })).dispatch?.maxConcurrent, 2);
	assert.throws(() => loadSuite(dispatchSuite({ herdrAgents: "nowhere" })), /dispatch\.herdrAgents has no/);
	assert.throws(() => loadSuite(dispatchSuite({ maxLaunches: 0 })), /maxLaunches must be a positive integer/);
	const root = dispatchSuite();
	const file = join(root, "tasks", "t1", "task.json");
	writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), home: "work" }));
	assert.throws(() => loadSuite(root), /home "work" is not supported/);
	// Without `dispatch`, a suite has none and its command line is the single-agent one.
	writeFileSync(join(root, "suite.json"), JSON.stringify({ model: "m/x", thinking: "medium" }));
	writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), home: undefined }));
	const plain = loadSuite(root);
	assert.equal(plain.dispatch, undefined);
	const args = piArgs(plain, plain.tasks[0], "routed", "/s");
	assert.ok(args.includes("-p") && args.includes("-nc") && args.includes("--append-system-prompt"));
	assert.throws(() => dispatchArgs(plain, "bare", "/s"), /not a dispatch suite/);
});

test("dispatch: the main runs in RPC mode with astra as its only model, the host and exp-dispatch, no appended prompt flag", () => {
	const s = loadSuite(dispatchSuite());
	const args = dispatchArgs(s, "routed", "/sess");
	const at = (flag: string) => args[args.indexOf(flag) + 1];
	assert.equal(at("--mode"), "rpc");
	assert.equal(at("--model"), "openai-codex/gpt-6.2-astra");
	assert.equal(at("--models"), "openai-codex/gpt-6.2-astra");
	assert.equal(at("--session-dir"), "/sess");
	assert.ok(!args.includes("-p") && !args.includes("-nc") && !args.includes("--append-system-prompt"));
	for (const flag of ["-ns", "-ne", "-np", "--no-mcp", "-na", "--offline"]) assert.ok(args.includes(flag), flag);
	const extensions = args.flatMap((a, i) => (a === "-e" ? [args[i + 1]] : []));
	assert.deepEqual(extensions, [join(s.dir, "vendor/pi-herdr-agents/pi-extension/subagents/index.ts"), expDispatchPath(), join(s.dir, "ledger.ts"), join(s.dir, "guard.ts")]);
	assert.ok(existsSync(expDispatchPath()));
	assert.deepEqual(args.flatMap((a, i) => (a === "--skill" ? [args[i + 1]] : [])), [join(s.dir, "skills")]);
	assert.ok(!args.includes("--"), "the prompt goes over stdin");
});

test("dispatch: the agent dir gives children the main's arm, astra only, no worktree-capable nesting", () => {
	const s = loadSuite(dispatchSuite());
	const files = dispatchAgentFiles(s, "routed");
	const settings = JSON.parse(files["settings.json"]);
	assert.deepEqual(settings.extensions.slice(0, 4), ["-builtin:mcp", "-builtin:tool-search", "-builtin:codemode", "-builtin:llama.cpp"]);
	assert.deepEqual(settings.extensions.slice(4), [join(s.dir, "ledger.ts"), join(s.dir, "guard.ts"), expDispatchPath()]);
	assert.deepEqual(settings.skills, [join(s.dir, "skills"), `!${join(homedir(), ".agents", "skills")}/**`]);
	assert.equal(settings.defaultProjectTrust, "never");
	assert.equal(files["APPEND_SYSTEM.md"], "Route through skills.\n\nSecond part.\n");
	const config = JSON.parse(files["herdr-agents/config.json"]);
	assert.equal(config.herdr.backend, "legacy");
	assert.equal(config.models.default, "openai-codex/gpt-6.2-astra");
	assert.ok(Object.values(config.models.tasks).every((v) => JSON.stringify(v) === JSON.stringify(["openai-codex/gpt-6.2-astra"])));
	assert.ok(Object.values(config.models.tasksThinking).every((v) => v === "medium"));
	assert.equal(config.spawning.maxDepth, 1);
	assert.equal(config.guidelines.launchRoster, false);
	assert.equal(dispatchAgentFiles(s, "bare")["APPEND_SYSTEM.md"], undefined, "bare gets no appended prompt");
});

// A stand-in for `pi --mode rpc`: one run per prompt; the first /exp-busy says busy and a child result starts a
// second run; later probes say not busy. Every prompt it receives goes to prompts.txt.
const FAKE_RPC = `#!/usr/bin/env node
const fs = require("node:fs");
const out = (r) => process.stdout.write(JSON.stringify(r) + "\\n");
let buf = "", probes = 0;
const run = () => { out({ type: "agent_start" }); setTimeout(() => out({ type: "agent_settled", aborted: false }), 20); };
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const cmd = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (cmd.type !== "prompt") continue;
    fs.appendFileSync("prompts.txt", cmd.message + "\\n");
    if (process.env.FAKE_HANG) { out({ id: cmd.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } }); out({ type: "agent_start" }); continue; }
    if (cmd.message === "/exp-busy") {
      out({ id: cmd.id, type: "response", command: "prompt", success: true, data: { disposition: process.env.FAKE_NO_EXT ? "started" : "handled" } });
      probes++;
      out({ type: "extension_ui_request", id: "n" + probes, method: "notify", message: "exp-busy " + JSON.stringify({ busy: probes === 1 }) });
      if (probes === 1) setTimeout(run, 150);
    } else {
      out({ id: cmd.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
      out({ type: "extension_ui_request", id: "d" + probes, method: "confirm", title: "?" });
      run();
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

function fakeRpc() {
	const dir = mkdtempSync(join(tmpdir(), "exp-rpc-"));
	const bin = join(dir, "pi");
	writeFileSync(bin, FAKE_RPC);
	chmodSync(bin, 0o755);
	return dir;
}

test("rpc: waits while children are out, then sends the follow-up once, then closes", async () => {
	const dir = fakeRpc();
	const r = await runRpc({ bin: join(dir, "pi"), args: [], cwd: dir, env: process.env, trialDir: dir, timeoutMs: 20_000, prompt: "task", followUp: "anything left?", graceMs: 50 });
	assert.equal(r.timedOut, false);
	assert.equal(r.exit, 0);
	assert.equal(r.followedUp, true);
	assert.equal(r.error, undefined);
	assert.ok(r.waitedMs >= 100, `waited ${r.waitedMs} ms for the child`);
	assert.deepEqual(readFileSync(join(dir, "prompts.txt"), "utf8").trim().split("\n"), ["task", "/exp-busy", "/exp-busy", "anything left?", "/exp-busy"]);
	const events = readFileSync(join(dir, "events.jsonl"), "utf8");
	assert.match(events, /"method":"confirm"/);
});

test("rpc: a probe pi does not treat as a command stops the trial; the timeout kills a main that never settles", async () => {
	const dir = fakeRpc();
	const noExt = await runRpc({ bin: join(dir, "pi"), args: [], cwd: dir, env: { ...process.env, FAKE_NO_EXT: "1" }, trialDir: dir, timeoutMs: 20_000, prompt: "task", graceMs: 50 });
	assert.match(noExt.error ?? "", /exp-dispatch extension is not loaded/);
	const hang = await runRpc({ bin: join(dir, "pi"), args: [], cwd: dir, env: { ...process.env, FAKE_HANG: "1" }, trialDir: dir, timeoutMs: 300, prompt: "task" });
	assert.equal(hang.timedOut, true);
	assert.equal(hang.signal, "SIGTERM");
});

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const usage = (cost: number) => ({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: cost } });
const stamp = (skills: string[], appendSha: string) => ({ type: "custom", customType: "exp-arm-stamp", data: { skills, tools: ["read"], appendChars: appendSha ? 30 : 0, appendSha } });

function dispatchTrial(child: { skills?: string[]; leakPath?: string; stamped?: boolean } = {}) {
	const s = loadSuite(dispatchSuite());
	const trialDir = mkdtempSync(join(tmpdir(), "exp-dtrial-"));
	const childFile = join(trialDir, "agent", "sessions", "--w--", "c.jsonl");
	mkdirSync(join(trialDir, "session", "artifacts", "x"), { recursive: true });
	mkdirSync(join(childFile, ".."), { recursive: true });
	writeFileSync(join(trialDir, "outcome.json"), JSON.stringify({ exit: 0, signal: null, timedOut: false, wallMs: 60_000, startedAt: "", endedAt: "", dirty: true, quota: false, checkExit: 0, dispatch: { waitedMs: 4000, probes: 3, workspaceClosed: true, leftover: 0, aliveAfter: 0 } }));
	// A child artifact below the session dir must not be taken for the main's session.
	writeFileSync(join(trialDir, "session", "artifacts", "x", "a.jsonl"), line({ type: "session" }));
	writeFileSync(
		join(trialDir, "session", "main.jsonl"),
		[
			{ type: "session", timestamp: "2026-11-26T00:00:00Z" },
			stamp(["anchorloop"], "abc"),
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "s1", name: "subagent", arguments: { name: "greeter", task: "edit" } }], usage: usage(0.5) } },
			{ type: "message", message: { role: "toolResult", toolCallId: "s1", toolName: "subagent", isError: false, details: { name: "greeter", sessionFile: childFile, model: "openai-codex/gpt-6.2-astra", status: "started" } } },
			{ type: "custom", customType: "exp-dispatch", data: { launches: 1, blocked: 0, results: 0, maxConcurrentSeen: 1 } },
			{ type: "custom_message", customType: "subagent_result", content: "done", details: { name: "greeter" } },
			{ type: "custom", customType: "exp-dispatch", data: { launches: 1, blocked: 0, results: 1, maxConcurrentSeen: 1 } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "The child changed it." }], usage: usage(0.25) } },
		]
			.map(line)
			.join(""),
	);
	writeFileSync(
		childFile,
		[
			{ type: "session", timestamp: "2026-11-26T00:00:10Z" },
			...(child.stamped === false ? [] : [stamp(child.skills ?? ["anchorloop"], "abc")]),
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "w", name: child.leakPath ? "read" : "write", arguments: { path: child.leakPath ?? "greet.txt" } }], usage: usage(1) } },
			{ type: "message", message: { role: "toolResult", toolCallId: "w", isError: false } },
			{ type: "message", timestamp: "2026-11-26T00:00:40Z", message: { role: "assistant", content: [{ type: "text", text: "Done." }], usage: usage(1) } },
		]
			.map(line)
			.join(""),
	);
	return { s, trialDir, childFile };
}

test("grade: children are found under the trial's agent dir, named from the launch, and add to the trial's cost", () => {
	const { s, trialDir, childFile } = dispatchTrial();
	assert.equal(findSession(join(trialDir, "session")), join(trialDir, "session", "main.jsonl"));
	const r = gradeTrial({ suite: s, task: s.tasks[0], arm: "routed", n: 1, trialDir });
	assert.equal(r.valid, true, String(r.invalid));
	assert.equal(r.outcome, true);
	assert.equal(r.children?.length, 1);
	const c = r.children?.[0];
	assert.equal(c?.session, childFile);
	assert.equal(c?.name, "greeter");
	assert.equal(c?.model, "openai-codex/gpt-6.2-astra");
	assert.equal(c?.turns, 2);
	assert.equal(c?.cost, 2);
	assert.equal(c?.tokens, 30);
	assert.equal(c?.wallMs, 30_000);
	assert.equal(r.efficiency.cost, 0.75, "efficiency stays the main's");
	assert.equal(r.childEfficiency?.cost, 2);
	assert.equal(r.totalEfficiency?.cost, 2.75);
	assert.equal(r.totalEfficiency?.wallMs, 90_000);
	assert.deepEqual(r.dispatch, { launches: 1, blocked: 0, results: 1, maxConcurrentSeen: 1, waitedMs: 4000, leftover: 0, aliveAfter: 0, workspaceClosed: true, calls: 1 });
	const sum = summarize([r], ["routed"]);
	assert.equal(sum.arms[0].costPerTrial, 2.75);
	assert.equal(sum.arms[0].childrenPerTrial, 1);
	assert.equal(summarize([{ ...r, children: undefined, totalEfficiency: undefined }], ["routed"]).arms[0].childrenPerTrial, undefined);
});

test("grade: a child's leak, or a child without its arm, makes the trial invalid", () => {
	const leak = dispatchTrial({ leakPath: join(tmpdir(), "x", "..", "nothing") });
	const leakSuite = { ...leak.s, forbidden: [join(tmpdir(), "x", "..", "nothing")] };
	const r1 = gradeTrial({ suite: leakSuite, task: leak.s.tasks[0], arm: "routed", n: 1, trialDir: leak.trialDir });
	assert.equal(r1.valid, false);
	assert.match(r1.invalid ?? "", /^leak: child greeter: read/);
	const bare = dispatchTrial({ skills: [] });
	const r2 = gradeTrial({ suite: bare.s, task: bare.s.tasks[0], arm: "routed", n: 1, trialDir: bare.trialDir });
	assert.match(r2.invalid ?? "", /^arm_mismatch: child greeter: skills differ/);
	const none = dispatchTrial({ stamped: false });
	assert.match(gradeTrial({ suite: none.s, task: none.s.tasks[0], arm: "routed", n: 1, trialDir: none.trialDir }).invalid ?? "", /child greeter: no arm stamp/);
	// The main itself must show its arm: the routed arm appends a prompt and loads skills, bare neither.
	const routed = loadSuite(dispatchSuite()).arms.get("routed")!;
	const bareArm = loadSuite(dispatchSuite()).arms.get("bare")!;
	assert.equal(stampMismatch(routed, { skills: ["a"], tools: [], appendChars: 10, appendSha: "x" }), undefined);
	assert.match(stampMismatch(bareArm, { skills: [], tools: [], appendChars: 10, appendSha: "x" }) ?? "", /main has the appended/);
	assert.match(stampMismatch(routed, undefined) ?? "", /main has no arm stamp/);
});

test("herdr lab: pane shells get the runner's HOME back and start without user rc files", () => {
	const sh = paneShell("/Users/me", { XDG_CONFIG_HOME: "/Users/me/.cfg" });
	assert.match(sh, /HOME='\/Users\/me'; export HOME/);
	assert.match(sh, /XDG_CONFIG_HOME='\/Users\/me\/\.cfg'; export XDG_CONFIG_HOME/);
	assert.match(sh, /unset XDG_STATE_HOME/);
	assert.match(sh, /exec \/bin\/sh "\$@"/);
	const toml = labConfig("/tmp/pe-x/pane-shell.sh");
	assert.match(toml, /default_shell = "\/tmp\/pe-x\/pane-shell.sh"/);
	assert.match(toml, /shell_mode = "non_login"/);
	assert.match(toml, /resume_agents_on_restore = false/);
});

test("sweep: a trial's processes are found by agent dir, by work dir and as descendants, and killed; others are left", async () => {
	const value = mkdtempSync(join(tmpdir(), "exp-agentdir-"));
	const work = mkdtempSync(join(tmpdir(), "exp-work-"));
	const node = process.execPath;
	// A node process carries the agent dir (as pi does) and has a child of its own; /bin/sleep runs in the work dir.
	const parent = spawn(node, ["-e", "require('child_process').spawn('sleep',['30'],{stdio:'ignore'}); setTimeout(()=>{},30000)"], { env: { ...process.env, PI_CODING_AGENT_DIR: value }, detached: true, stdio: "ignore" });
	const inWork = spawn("sleep", ["30"], { cwd: work, detached: true, stdio: "ignore" });
	const other = spawn("sleep", ["30"], { env: { ...process.env, PI_CODING_AGENT_DIR: `${value}-other` }, detached: true, stdio: "ignore" });
	const match = { env: { key: "PI_CODING_AGENT_DIR", value }, cwd: work };
	try {
		await new Promise((r) => setTimeout(r, 500));
		const found = trialProcesses(match);
		assert.ok(found.includes(parent.pid as number), "the process with the agent dir");
		assert.ok(found.includes(inWork.pid as number), "the process in the work dir");
		assert.equal(found.length, 3, "plus the agent-dir process's child");
		assert.ok(!found.includes(other.pid as number));
		assert.equal(await sweepProcesses(match, 2_000), 3);
		await new Promise((r) => setTimeout(r, 200));
		assert.deepEqual(trialProcesses(match), []);
	} finally {
		for (const p of [parent, inWork, other]) p.kill("SIGKILL");
	}
});
