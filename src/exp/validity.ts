/**
 * The validity gate per task: the fixture builds; the prompt does not hand both arms an anchor; the base fails the
 * hidden check; the reference passes it 3 of 3 times (flake screen), each run under 3 minutes. For should-not tasks the
 * reference answer passes the fact list on a clean tree and an empty answer fails it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneTree } from "./fixture.ts";
import { runScreenshot, screenshotGate } from "./artifacts.ts";
import { promptCreditsAnchor, shouldNotOutcome } from "./grade.ts";
import type { Task } from "./task.ts";

export interface GateResult {
	task: string;
	ok: boolean;
	lines: string[];
}

/** A reference check slower than this fails the gate; a task that sets check_timeout_s raises it to that. */
const LIMIT_MS = 180_000;
const limitMs = (task: Task) => (task.check_timeout_s ? task.check_timeout_s * 1000 : LIMIT_MS);

function check(task: Task, work: string): { exit: number | null; ms: number; tail: string } {
	rmSync(join(work, ".exp-check"), { recursive: true, force: true });
	cpSync(join(task.dir, "check"), join(work, ".exp-check"), { recursive: true });
	mkdirSync(join(work, ".exp-check", "artifacts"), { recursive: true });
	const started = Date.now();
	const env = { ...process.env, ...(task.home === "work" ? { HOME: work } : {}), EXP_CHECK_DIR: join(work, ".exp-check"), EXP_ARTIFACT_DIR: join(work, ".exp-check", "artifacts") };
	const r = spawnSync("bash", [join(".exp-check", "check.sh")], { cwd: work, env, encoding: "utf8", timeout: (task.check_timeout_s ?? 300) * 1000, maxBuffer: 1 << 26 });
	const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n");
	return { exit: r.status, ms: Date.now() - started, tail: out.slice(-3).join(" | ") };
}

/**
 * `runs` reference runs (default 3; `exp check --ref-runs` lowers it for slow verifiers). A task with `screenshot` also
 * passes the screenshot gate, its shots kept in `shotsDir` (default inside the throwaway gate dir).
 */
export function gate(task: Task, fixture: string, options: { runs?: number; shotsDir?: string } = {}): GateResult {
	const lines: string[] = [];
	let ok = true;
	const fail = (line: string) => {
		ok = false;
		lines.push(`FAIL ${line}`);
	};
	// Process metrics count only on tasks that ask for a change, so only their prompts must leave the anchor to the agent.
	if (task.kind === "should_not") lines.push("n/a  prompt anchor (process is not scored on should_not tasks)");
	else if (promptCreditsAnchor(task.prompt)) fail("prompt names a check: the detectors would credit both arms with an anchor (anchor_in_brief)");
	else lines.push("ok   prompt hands no anchor to either arm");
	if (task.kind === "should_not") {
		const answer = readFileSync(join(task.dir, task.reference.answer as string), "utf8");
		const ref = shouldNotOutcome({ finalText: answer, dirty: false, edits: 0, facts: task.facts ?? [] });
		if (ref.pass) lines.push(`ok   reference answer names all ${task.facts?.length} facts`);
		else fail(`reference answer misses ${ref.missing.join(", ")}`);
		if (shouldNotOutcome({ finalText: "", dirty: false, edits: 0, facts: task.facts ?? [] }).pass) fail("an empty answer passes");
		else lines.push("ok   an empty answer fails");
		if (shouldNotOutcome({ finalText: answer, dirty: true, edits: 1, facts: task.facts ?? [] }).pass) fail("an edited tree passes");
		else lines.push("ok   the reference answer with an edit fails");
		return { task: task.id, ok, lines };
	}
	const box = mkdtempSync(join(tmpdir(), `pi-evals-gate-${task.id}-`));
	try {
		const base = join(box, "base");
		cloneTree(fixture, base);
		const b = check(task, base);
		if (b.exit === 0) fail(`base passes the check (${b.tail})`);
		else lines.push(`ok   base fails the check (exit ${b.exit}, ${(b.ms / 1000).toFixed(1)} s: ${b.tail})`);
		const ref = join(box, "reference");
		cloneTree(fixture, ref);
		execFileSync("git", ["apply", "--whitespace=nowarn", join(task.dir, task.reference.patch as string)], { cwd: ref });
		for (let i = 1; i <= (options.runs ?? 3); i++) {
			const r = check(task, ref);
			if (r.exit !== 0) fail(`reference run ${i} fails the check (exit ${r.exit}: ${r.tail})`);
			else if (r.ms > limitMs(task)) fail(`reference run ${i} takes ${(r.ms / 1000).toFixed(0)} s (limit ${limitMs(task) / 1000} s)`);
			else lines.push(`ok   reference run ${i} passes (${(r.ms / 1000).toFixed(1)} s)`);
		}
		if (task.screenshot) {
			const shots = screenshotGate(task, { base, reference: ref }, options.shotsDir ?? join(box, "gate-shots"), (work, dir) => runScreenshot(task, work, process.env, dir));
			for (const line of shots.lines) (line.startsWith("FAIL ") ? fail(line.slice(5)) : lines.push(line));
		}
	} finally {
		rmSync(box, { recursive: true, force: true });
	}
	return { task: task.id, ok, lines };
}
