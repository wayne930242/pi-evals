/**
 * Per-trial artifacts: the check and the screenshot step get `EXP_ARTIFACT_DIR`, and a task with `screenshot` runs
 * that script after its check. The screenshot is recorded beside the outcome and never changes it. The gate shoots
 * the base and the reference twice each and requires a stable reference that differs from the base.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "./task.ts";

export const SHOT = "shot.png";

export interface ScreenshotRaw {
	exit: number | null;
	ms: number;
	/** The PNG, relative to the trial dir, when the script wrote one. */
	file?: string;
	sha256?: string;
}

export const sha256File = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Width × height from a PNG's IHDR chunk, or undefined when the file is not a PNG. */
export function pngPixels(file: string): number | undefined {
	const b = readFileSync(file);
	if (b.length < 24 || b.toString("latin1", 1, 4) !== "PNG" || b.toString("latin1", 12, 16) !== "IHDR") return undefined;
	return b.readUInt32BE(16) * b.readUInt32BE(20);
}

/** Run the task's screenshot script in `work` (its check already copied to `.exp-check`); the PNG lands in `artifactDir`. */
export function runScreenshot(task: Task, work: string, env: NodeJS.ProcessEnv, artifactDir: string, log?: string): ScreenshotRaw {
	if (!task.screenshot) throw new Error(`${task.id} has no screenshot step`);
	mkdirSync(artifactDir, { recursive: true });
	const shot = join(artifactDir, SHOT);
	rmSync(shot, { force: true });
	const started = Date.now();
	const r = spawnSync("bash", [join(".exp-check", task.screenshot.script)], {
		cwd: work,
		env: { ...env, EXP_CHECK_DIR: join(work, ".exp-check"), EXP_ARTIFACT_DIR: artifactDir },
		encoding: "utf8",
		timeout: (task.screenshot.timeout_s ?? 600) * 1000,
		maxBuffer: 1 << 26,
	});
	if (log) writeFileSync(log, `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}\n` : ""}\nexit ${r.status}\n`);
	const ok = existsSync(shot) && pngPixels(shot) !== undefined;
	return { exit: r.status, ms: Date.now() - started, ...(ok ? { file: join("artifacts", SHOT), sha256: sha256File(shot) } : {}) };
}

/** Differing pixels between two shots via the task's `check/compare.sh A B`, or undefined when it has none or it fails. */
function comparePixels(work: string, a: string, b: string): number | undefined {
	const script = join(work, ".exp-check", "compare.sh");
	if (!existsSync(script)) return undefined;
	const r = spawnSync("bash", [script, a, b], { cwd: work, encoding: "utf8", timeout: 300_000 });
	const n = Number(/(\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*$/i.exec((r.stdout ?? "").trim())?.[1]);
	return Number.isFinite(n) ? n : undefined;
}

const share = (n: number, file: string) => n / (pngPixels(file) ?? 1);
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

/** Pass limits: the reference may move ≤ 0.1% between runs; base and reference must differ by ≥ 0.5%. */
export const SHOT_UNSTABLE = 0.001;
export const SHOT_CHANGED = 0.005;

/**
 * The screenshot gate. `shoot(work, artifactDir)` runs the screenshot step in a prepared tree; base and reference are
 * shot twice each, and the first shots are kept as `<shotsDir>/{base,reference}.png` for the review page.
 */
export function screenshotGate(task: Task, trees: { base: string; reference: string }, shotsDir: string, shoot: (work: string, artifactDir: string) => ScreenshotRaw): { ok: boolean; lines: string[] } {
	const lines: string[] = [];
	let ok = true;
	const fail = (line: string) => {
		ok = false;
		lines.push(`FAIL ${line}`);
	};
	mkdirSync(shotsDir, { recursive: true });
	const shots: Record<"base" | "reference", string[]> = { base: [], reference: [] };
	for (const which of ["base", "reference"] as const) {
		for (let i = 1; i <= 2; i++) {
			const dir = join(shotsDir, `.run-${which}-${i}`);
			const r = shoot(trees[which], dir);
			if (!r.sha256) {
				fail(`${which} screenshot ${i} wrote no PNG (exit ${r.exit}, ${(r.ms / 1000).toFixed(1)} s)`);
				continue;
			}
			const kept = join(shotsDir, `${which}-${i}.png`);
			copyFileSync(join(dir, SHOT), kept);
			rmSync(dir, { recursive: true, force: true });
			shots[which].push(kept);
			lines.push(`ok   ${which} screenshot ${i} (${(r.ms / 1000).toFixed(1)} s, ${r.sha256.slice(0, 12)})`);
		}
	}
	const [r1, r2] = shots.reference;
	const [b1] = shots.base;
	if (r1 && r2) {
		if (sha256File(r1) === sha256File(r2)) lines.push("ok   reference screenshot is stable (same sha256)");
		else {
			const n = comparePixels(trees.reference, r1, r2);
			if (n === undefined) fail("reference screenshot differs between runs and the task has no compare.sh");
			else if (share(n, r1) <= SHOT_UNSTABLE) lines.push(`ok   reference screenshot is stable (${n} px, ${pct(share(n, r1))})`);
			else fail(`reference screenshot is unstable (${n} px, ${pct(share(n, r1))} > ${pct(SHOT_UNSTABLE)})`);
		}
	}
	if (r1 && b1) {
		const n = comparePixels(trees.reference, b1, r1);
		if (n === undefined) {
			if (sha256File(b1) === sha256File(r1)) fail("reference screenshot equals the base's");
			else lines.push("ok   reference screenshot differs from the base's (sha256)");
		} else if (share(n, r1) >= SHOT_CHANGED) lines.push(`ok   reference screenshot differs from the base's (${n} px, ${pct(share(n, r1))})`);
		else fail(`reference screenshot barely differs from the base's (${n} px, ${pct(share(n, r1))} < ${pct(SHOT_CHANGED)})`);
	}
	if (b1) copyFileSync(b1, join(shotsDir, "base.png"));
	if (r1) copyFileSync(r1, join(shotsDir, "reference.png"));
	return { ok, lines };
}

/** Where `exp check` keeps a task's gate shots (`base.png`, `reference.png`) for the review page. */
export const gateShotsDir = (fixturesRoot: string, task: string) => join(fixturesRoot, "gate-shots", task);
