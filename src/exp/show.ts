/** A terminal view of one run: per-arm rates, B − A with its 95% CI, and the per-task table, regressions first. */
import type { RunMeta } from "./run.ts";
import type { Metric, Summary } from "./summary.ts";
import type { TrialRecord } from "./trial.ts";

const NAMES: Record<Metric, string> = {
	outcome: "outcome pass@1",
	outcome_pass3: "outcome pass^3",
	process: "process (anchor+check)",
	anchor: "anchor before first edit",
	check: "check after last edit",
	todo_evidence: "todo evidence",
	close_guard_quiet: "close guard quiet",
	edited_when_should_not: "edited when should not",
	done_claim_fail: "done claim, check failed",
};

const pct = (v: number | undefined) => (v === undefined || Number.isNaN(v) ? "—" : `${Math.round(v * 100)}%`);
const pp = (v: number) => `${v >= 0 ? "+" : ""}${Math.round(v * 100)}`;
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));

export function show(meta: RunMeta, summary: Summary, records: TrialRecord[]): string {
	const arms = summary.arms.map((a) => a.arm);
	const guarded = (arm: string) => [...(meta.arms[arm]?.extensions ?? [])].some((e) => /close-guard/.test(e));
	const out: string[] = [];
	const valid = records.filter((r) => r.valid).length;
	out.push(`run ${meta.id} · ${meta.model} (${meta.thinking}) · pi ${meta.pi ?? "?"} · k=${meta.k} · ${meta.tasks.length} tasks · ${summary.arms.reduce((s, a) => s + a.trials, 0)} valid trials${meta.stopped ? ` · STOPPED: ${meta.stopped}` : ""}`);
	out.push(`started ${meta.startedAt}${meta.endedAt ? ` · ended ${meta.endedAt}` : " · running"} · ${records.length - valid} invalid record(s)`);
	out.push("");
	const w = 28;
	out.push(pad("metric", w) + arms.map((a) => pad(a, 12)).join("") + (summary.pair ? `${summary.pair[1]} − ${summary.pair[0]} (95% CI)` : ""));
	for (const metric of Object.keys(NAMES) as Metric[]) {
		const cells = summary.arms.map((a) => pad(metric === "close_guard_quiet" && !guarded(a.arm) ? "—" : pct(a.metrics[metric]), 12));
		const d = summary.deltas[metric];
		const delta = d && metric !== "close_guard_quiet" ? `${pp(d.delta)} pp (${pp(d.lo)} to ${pp(d.hi)})${d.lo <= 0 && d.hi >= 0 ? " no clear difference" : ""} · ${d.tasks} tasks` : "";
		out.push(pad(NAMES[metric], w) + cells.join("") + delta);
	}
	out.push(pad("cost per trial (USD equiv.)", w) + summary.arms.map((a) => pad(`$${a.costPerTrial.toFixed(2)}`, 12)).join(""));
	out.push(pad("minutes per trial", w) + summary.arms.map((a) => pad(a.minutesPerTrial.toFixed(1), 12)).join(""));
	out.push(pad("total cost", w) + summary.arms.map((a) => pad(`$${a.costTotal.toFixed(2)}`, 12)).join(""));
	out.push(pad("invalid trials", w) + summary.arms.map((a) => pad(String(a.invalid), 12)).join(""));
	out.push("");
	out.push(pad("task", 24) + pad("kind", 12) + arms.map((a) => pad(`${a} pass`, 16)).join("") + "Δ pass@1");
	for (const row of summary.tasks) {
		const cells = arms.map((a) => {
			const c = row.arms[a];
			return pad(c ? `${c.pass}/${c.n}${c.process === undefined ? "" : ` p${pct(c.process)}`}` : "—", 16);
		});
		out.push(pad(row.task, 24) + pad(row.kind, 12) + cells.join("") + (row.delta === undefined ? "" : pp(row.delta)));
	}
	if (summary.doneClaimFail.length) out.push("", `done claimed but check failed: ${summary.doneClaimFail.map((d) => `${d.task}/${d.arm}/${d.n}`).join(", ")}`);
	const invalid = records.filter((r) => !r.valid);
	if (invalid.length) out.push(`invalid: ${invalid.map((r) => `${r.task}/${r.arm}/${r.n} (${r.invalid})`).join(", ")}`);
	return out.join("\n");
}
