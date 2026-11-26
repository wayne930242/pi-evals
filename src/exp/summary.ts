/**
 * Per-arm and per-task aggregates from results.jsonl, and paired B − A deltas with cluster-bootstrap CIs. Only valid
 * trials count; a rerun trial replaces the earlier record of the same task, arm and number.
 */
import { pairedBootstrap, type Delta, passHatK, taskRate } from "./stats.ts";
import type { TrialRecord } from "./trial.ts";

export const METRICS = ["outcome", "outcome_pass3", "process", "anchor", "check", "todo_evidence", "close_guard_quiet", "edited_when_should_not", "done_claim_fail"] as const;
export type Metric = (typeof METRICS)[number];

const label = (r: TrialRecord, name: string) => r.process[name]?.label;
const bit = (l: string | undefined) => (l === "pass" ? 1 : l === "fail" ? 0 : undefined);
const doing = (r: TrialRecord) => r.kind !== "should_not";

/** A trial's value for a metric, or undefined where the metric does not apply. */
export function trialValue(r: TrialRecord, metric: Metric): number | undefined {
	switch (metric) {
		case "outcome":
		case "outcome_pass3":
			return r.outcome ? 1 : 0;
		case "anchor":
			return doing(r) ? bit(label(r, "anchor_before_first_edit")) : undefined;
		case "check":
			return doing(r) ? bit(label(r, "check_after_last_edit")) : undefined;
		case "process": {
			// 照流程: anchor and check both pass, on tasks that ask for a change and where a change was made.
			if (!doing(r)) return undefined;
			const a = label(r, "anchor_before_first_edit"), c = label(r, "check_after_last_edit");
			if (a === "na") return undefined;
			return a === "pass" && c === "pass" ? 1 : 0;
		}
		case "todo_evidence":
			return bit(label(r, "todo_evidence"));
		case "close_guard_quiet":
			return bit(label(r, "close_guard_quiet"));
		case "edited_when_should_not":
			return r.kind === "should_not" ? (r.editedWhenShouldNot ? 1 : 0) : undefined;
		case "done_claim_fail":
			return r.doneClaimVsOutcome ? 1 : 0;
	}
}

/** The per-task statistic over that task's trial values: pass^3 for outcome_pass3, else the mean. */
function statOf(metric: Metric, k: number) {
	return (xs: number[]) => (metric === "outcome_pass3" ? passHatK(xs.filter((x) => x === 1).length, xs.length, Math.min(k, xs.length)) : xs.reduce((s, x) => s + x, 0) / xs.length);
}

export interface ArmSummary {
	arm: string;
	trials: number;
	invalid: number;
	metrics: Partial<Record<Metric, number>>;
	costPerTrial: number;
	minutesPerTrial: number;
	costTotal: number;
}
export interface TaskRow {
	task: string;
	kind: string;
	arms: Record<string, { pass: number; n: number; process?: number }>;
	delta?: number;
}
export interface Summary {
	arms: ArmSummary[];
	tasks: TaskRow[];
	/** B − A for each metric, A and B the first two arms in run order. */
	deltas: Partial<Record<Metric, Delta>>;
	pair?: [string, string];
	doneClaimFail: { task: string; arm: string; n: number }[];
}

export function latestRecords(records: TrialRecord[]): TrialRecord[] {
	const by = new Map<string, TrialRecord>();
	for (const r of records) by.set(`${r.task}\0${r.arm}\0${r.n}`, r);
	return [...by.values()];
}

export function summarize(all: TrialRecord[], arms: string[], options: { k?: number; resamples?: number; seed?: number } = {}): Summary {
	const records = latestRecords(all);
	const valid = records.filter((r) => r.valid);
	const k = options.k ?? 3;
	const tasks = [...new Set(records.map((r) => r.task))].sort();
	const values = (task: string, arm: string, metric: Metric) =>
		valid.filter((r) => r.task === task && r.arm === arm).map((r) => trialValue(r, metric)).filter((v): v is number => v !== undefined);
	const armSummaries: ArmSummary[] = arms.map((arm) => {
		const mine = valid.filter((r) => r.arm === arm);
		const metrics: Partial<Record<Metric, number>> = {};
		for (const metric of METRICS) {
			const perTask = tasks.map((t) => {
				const xs = values(t, arm, metric);
				return xs.length ? statOf(metric, k)(xs) : undefined;
			});
			const rate = taskRate(perTask);
			if (rate !== undefined) metrics[metric] = rate;
		}
		const cost = mine.reduce((s, r) => s + r.efficiency.cost, 0);
		return {
			arm,
			trials: mine.length,
			invalid: records.filter((r) => r.arm === arm && !r.valid).length,
			metrics,
			costPerTrial: mine.length ? cost / mine.length : 0,
			minutesPerTrial: mine.length ? mine.reduce((s, r) => s + r.efficiency.wallMs, 0) / mine.length / 60_000 : 0,
			costTotal: cost,
		};
	});
	const pair = arms.length >= 2 ? ([arms[0], arms[1]] as [string, string]) : undefined;
	const deltas: Partial<Record<Metric, Delta>> = {};
	if (pair) {
		for (const metric of METRICS) {
			const paired = tasks.map((t) => ({ a: values(t, pair[0], metric), b: values(t, pair[1], metric) }));
			const d = pairedBootstrap(paired, statOf(metric, k), { resamples: options.resamples, seed: options.seed });
			if (d.tasks) deltas[metric] = d;
		}
	}
	const rows: TaskRow[] = tasks.map((task) => {
		const kind = records.find((r) => r.task === task)?.kind ?? "";
		const row: TaskRow = { task, kind, arms: {} };
		for (const arm of arms) {
			const xs = values(task, arm, "outcome");
			const p = values(task, arm, "process");
			row.arms[arm] = { pass: xs.filter((x) => x === 1).length, n: xs.length, ...(p.length ? { process: p.reduce((s, x) => s + x, 0) / p.length } : {}) };
		}
		if (pair) {
			const [a, b] = [row.arms[pair[0]], row.arms[pair[1]]];
			if (a.n && b.n) row.delta = b.pass / b.n - a.pass / a.n;
		}
		return row;
	});
	// Regressions first: the most negative B − A at the top, never averaged away.
	rows.sort((x, y) => (x.delta ?? 0) - (y.delta ?? 0) || x.task.localeCompare(y.task));
	const doneClaimFail = valid.filter((r) => r.doneClaimVsOutcome).map((r) => ({ task: r.task, arm: r.arm, n: r.n }));
	return { arms: armSummaries, tasks: rows, deltas, ...(pair ? { pair } : {}), doneClaimFail };
}

/** Trials whose task the two arms disagree on (outcome or process), plus every done claim on a failed outcome. */
export function flipped(all: TrialRecord[], pair: [string, string]): TrialRecord[] {
	const records = latestRecords(all).filter((r) => r.valid);
	const out = new Set<TrialRecord>();
	for (const task of new Set(records.map((r) => r.task))) {
		const a = records.filter((r) => r.task === task && r.arm === pair[0]);
		const b = records.filter((r) => r.task === task && r.arm === pair[1]);
		const rate = (xs: TrialRecord[], m: Metric) => taskRate(xs.map((r) => trialValue(r, m)));
		const differs = (m: Metric) => rate(a, m) !== rate(b, m);
		if (differs("outcome") || differs("process") || differs("edited_when_should_not")) for (const r of [...a, ...b]) out.add(r);
	}
	for (const r of records) if (r.doneClaimVsOutcome) out.add(r);
	return [...out];
}
