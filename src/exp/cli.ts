/** `pi-evals exp check|run|grade|show`: paired experiments, CLI-only (the extension never imports src/exp). */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { layout } from "../paths.ts";
import { buildFixture } from "./fixture.ts";
import { applyLabelAnswer, labelAgreement, writeLabelQueue } from "./labels.ts";
import { experimentsDir, fixturesDir, readResults, readRun, regradeRun, runExperiment, selectTasks, writeSummary } from "./run.ts";
import { show } from "./show.ts";
import { latestRecords } from "./summary.ts";
import { loadSuite } from "./task.ts";
import { gate } from "./validity.ts";

export const EXP_USAGE = `  pi-evals exp check <suite> [--task id]... [--rebuild]
  pi-evals exp run <suite> --arms a,b --k N [--tasks a,b] [--parallel N] [--run-id id] [--pi <bin>] [--rerun <reason>]
  pi-evals exp grade <run-id|dir>
  pi-evals exp show <run-id|dir> [--json]
  pi-evals exp label <run-id|dir> [--answer <file|->]   (page of flipped trials; --answer writes the labels)`;

function flag(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}
const flags = (args: string[], name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

function runDirOf(arg: string): string {
	const dir = isAbsolute(arg) || arg.startsWith(".") ? resolve(arg) : join(experimentsDir(), arg);
	if (!existsSync(join(dir, "run.json"))) throw new Error(`no run at ${dir}`);
	return dir;
}

export async function expMain(args: string[]): Promise<number> {
	const [sub, target, ...rest] = args;
	if (sub === "check" && target) {
		const suite = loadSuite(target);
		const tasks = selectTasks(suite, flags(rest, "--task"));
		let failed = 0;
		for (const task of tasks) {
			process.stdout.write(`${task.id} (${task.kind})\n`);
			const fixture = buildFixture(suite, task, fixturesDir(), { rebuild: rest.includes("--rebuild"), log: (line) => process.stderr.write(`  ${line}\n`) });
			const r = gate(task, fixture);
			for (const line of r.lines) process.stdout.write(`  ${line}\n`);
			if (!r.ok) failed++;
		}
		process.stdout.write(`${tasks.length - failed}/${tasks.length} tasks pass the validity gate\n`);
		return failed ? 1 : 0;
	}
	if (sub === "run" && target) {
		const arms = list(flag(rest, "--arms"));
		const k = Number(flag(rest, "--k"));
		if (!arms?.length || !Number.isInteger(k) || k < 1) throw new Error("exp run needs --arms a,b and --k N");
		const parallel = flag(rest, "--parallel");
		const r = await runExperiment({
			suiteDir: target,
			arms,
			k,
			tasks: list(flag(rest, "--tasks")),
			parallel: parallel === undefined ? undefined : Number(parallel),
			runId: flag(rest, "--run-id"),
			piBin: flag(rest, "--pi"),
			rerun: flag(rest, "--rerun"),
			onProgress: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
		});
		process.stdout.write(`${JSON.stringify({ result: { runDir: r.runDir, trials: r.records.length, stopped: r.stopped } })}\n`);
		return r.stopped ? 3 : 0;
	}
	if (sub === "grade" && target) {
		const dir = runDirOf(target);
		const records = regradeRun(dir);
		process.stdout.write(`regraded ${records.length} trials in ${dir}\n`);
		return 0;
	}
	if (sub === "show" && target) {
		const dir = runDirOf(target);
		const meta = readRun(dir);
		const summary = writeSummary(dir, meta);
		const records = latestRecords(readResults(dir));
		const agreement = labelAgreement(meta, records, layout().labels);
		process.stdout.write(rest.includes("--json") ? `${JSON.stringify({ ...summary, agreement }, null, 2)}\n` : `${show(meta, summary, records, agreement)}\n`);
		return 0;
	}
	if (sub === "label" && target) {
		const dir = runDirOf(target);
		const meta = readRun(dir);
		const answer = flag(rest, "--answer");
		if (answer) {
			const rows = applyLabelAnswer(dir, meta, readFileSync(answer === "-" ? 0 : answer, "utf8"), layout().labels);
			process.stdout.write(`wrote ${rows.length} experiment label(s) to ${layout().labels}\n`);
			return rows.length ? 0 : 1;
		}
		const q = writeLabelQueue(dir, meta, readResults(dir));
		process.stdout.write(`${q.items.length} flipped trial(s): ${q.page}\n`);
		return 0;
	}
	process.stderr.write(`usage:\n${EXP_USAGE}\n`);
	return 1;
}
