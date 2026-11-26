/** The `labels` view of `evals_query` and its line in `findings`: names and numbers, never a note. */
import { type ReportModel, SMALL_SAMPLE } from "./model.ts";

/** Corrections of one rule and failure type that make a findings line. */
export const CLUSTER = 3;

const list = (rows: { n: number }[], name: (r: never) => string, limit = 6) => rows.slice(0, limit).map((r) => `${name(r as never)} ${r.n}`).join(", ") || "none";
const ratio = (c: { agree: number; n: number }) => `${c.agree}/${c.n}`;

export function labelsView(m: ReportModel): string[] {
	const l = m.labels;
	if (l.needsIndex) return ["labels in this range need an index with session ids: the user can run /evals extract"];
	const c = l.corrections;
	const out = [
		"human labels = your verdicts on a rule; after the fact (batch) or in the moment (/evals label)",
		`human: after the fact ${l.bySource.batch} (${l.sessions.batch} sessions), in the moment ${l.bySource.live} (${l.sessions.live} sessions${l.fromWords ? `; ${l.fromWords} formatted by the agent from your words` : ""}); unclear ${l.unclear}; no code verdict ${l.noCode}; on other ${l.other}`,
		"code vs human, agreed/compared (after the fact; in the moment):",
	];
	for (const a of l.agreement) out.push(`${a.detector}: ${ratio(a)} (${ratio(a.bySource.batch)}; ${ratio(a.bySource.live)})`);
	out.push(`corrections the agent logged (not all mistakes): ${c.n} in ${c.sessions} sessions${c.n && c.n < SMALL_SAMPLE ? `; small (<${SMALL_SAMPLE}), a hint not a trend` : ""}`);
	if (c.n) {
		out.push(`by rule: ${list(c.byRule, (r: { rule: string }) => r.rule)}`);
		out.push(`by type: ${list(c.byType, (r: { type: string }) => r.type)}`);
		out.push(`by rule/type: ${list(c.byRuleType, (r: { rule: string; type: string }) => `${r.rule}/${r.type}`, 4)}`);
		out.push(`by skill loaded (one correction counts for each): ${list(c.bySkill, (r: { skill: string }) => r.skill || "(none)")}`);
		out.push(`by anchorloop version: ${list(c.byVersion, (r: { version: string }) => r.version)}`);
	}
	return out;
}

/** A findings line when corrections of one rule and type recur. */
export function correctionsFinding(m: ReportModel): string | undefined {
	const c = m.labels.corrections, top = c.byRuleType[0];
	if (!top || top.n < CLUSTER) return undefined;
	return `Corrections logged: ${top.n} of ${c.n} are ${top.rule}/${top.type} (agent-logged, not all mistakes) → labels`;
}
