/** `evals_query`: bounded plain-text summaries of the index for an agent (names and numbers only, under 2 KB). */
import { coverageNow, model, reportPath } from "./ops.ts";
import type { Rate } from "./model.ts";

export const VIEWS = ["skills", "packages", "ask_user", "monitors", "subagents", "process", "cost", "changes", "coverage"] as const;
export type View = (typeof VIEWS)[number];
export const MAX_BYTES = 1900;

const pct = (r: Rate | null | undefined) => (r && r.value !== null ? `${(r.value * 100).toFixed(1)}% (n=${r.n})` : `n/a (n=${r?.n ?? 0})`);
const sec = (v: number | null) => (v === null ? "n/a" : `${(v / 1000).toFixed(1)}s`);

/** Cuts text to the byte limit at a line boundary. */
export function bound(text: string, limit = MAX_BYTES): string {
	if (Buffer.byteLength(text) <= limit) return text;
	const lines = text.split("\n");
	while (lines.length > 1 && Buffer.byteLength(`${lines.join("\n")}\n…`) > limit) lines.splice(lines.length - 2, 1);
	return `${lines.join("\n")}\n…`.slice(0, limit);
}

export function query(view: View, options: { since?: string; project?: string; env?: Record<string, string | undefined> } = {}): string {
	if (view === "coverage") {
		const c = coverageNow(options.env);
		return bound(
			[
				`coverage, sessions inactive > ${c.cutDays} days (before ${c.cutoff.slice(0, 10)}):`,
				`indexed ${c.indexed.files}/${c.old.files} files, ${(c.indexed.bytes / 1e9).toFixed(2)} of ${(c.old.bytes / 1e9).toFixed(2)} GB; not indexed ${c.notIndexed.files}`,
				`all files: ${c.all.indexedFiles}/${c.all.files} indexed; index keeps ${c.retainedGone} sessions whose file is gone`,
				"meaning: only indexed files keep their numbers if the session files are cleaned up",
			].join("\n"),
		);
	}
	const m = model({ since: options.since, project: options.project }, options.env, false);
	if (!m) return "pi-evals: nothing extracted yet; the user can run /evals extract.";
	const head = [
		`pi-evals ${view} · ${m.window.since ?? "?"}..${m.window.until ?? "?"}${m.window.project ? ` · project ${m.window.project}` : ""} · sessions ${m.totals.sessions}`,
		m.freshness.stale ? `STALE: last extract ${m.freshness.lastExtract ?? "never"} (${m.freshness.ageHours ?? "?"}h ago); /evals extract refreshes` : `last extract ${m.freshness.lastExtract}`,
	];
	const body: string[] = [];
	if (view === "skills") {
		body.push("skill: loads / sessions");
		for (const s of m.skills.top.slice(0, 15)) body.push(`${s.name}: ${s.loads} / ${s.sessions}`);
		body.push(`ways: ${Object.entries(m.skills.triggers).map(([k, v]) => `${k} ${v}`).join(", ")}`);
		body.push(`offered but never loaded (${m.skills.neverLoaded.length}/${m.skills.offered}): ${m.skills.neverLoaded.slice(0, 25).join(", ")}`);
	} else if (view === "packages") {
		body.push("package: calls, error rate, avg time");
		for (const p of m.packages.slice(0, 15)) body.push(`${p.owner}${p.version ? `@${p.version}` : ""}: ${p.calls}, ${pct(p.errorRate)}, ${sec(p.avgMs)}`);
	} else if (view === "ask_user") {
		const a = m.askUser;
		body.push(`questions ${a.calls}; dismissed ${pct(a.cancelRate)}; avg wait for answer ${sec(a.avgWaitMs)} (n=${a.waitN}); errors ${a.errors}`);
		body.push(`answer source: ${Object.entries(a.sources).map(([k, v]) => `${k} ${v}`).join(", ") || "n/a"}`);
	} else if (view === "monitors") {
		const mo = m.monitors;
		body.push(`started ${mo.started}; ending recorded ${mo.finished}; avg duration ${sec(mo.avgMs)} (n=${mo.durationN})`);
		body.push(`outcomes: ${Object.entries(mo.statuses).map(([k, v]) => `${k} ${v}`).join(", ") || "n/a"}`);
	} else if (view === "subagents") {
		body.push(`subagent sessions ${m.subagents.sessions}; linked to parent ${m.subagents.linked}/${m.subagents.subagentTotal} (all time)`);
		body.push("role / model: launches");
		for (const l of m.subagents.launches.slice(0, 12)) body.push(`${l.role} / ${l.model}: ${l.n}`);
		body.push(`cost by role: ${m.subagents.costByRole.slice(0, 8).map((r) => `${r.role} $${r.cost}`).join(", ")}`);
	} else if (view === "process") {
		body.push(`judged from ${m.process.eraStart} (anchorloop 3.0.0); pass rate = followed / (followed + not followed)`);
		for (const d of m.process.detectors) {
			const label = m.meta.detectors[d.name]?.label.en ?? d.name;
			body.push(`${d.name} (${label}): ${pct(d.passRate)}, not applicable ${d.na}`);
			const versions = d.byVersion.filter((v) => v.pass + v.fail > 0).map((v) => `${v.version} ${pct(v.passRate)}`);
			if (versions.length) body.push(`  by anchorloop version: ${versions.slice(-4).join("; ")}`);
		}
		body.push(`close-guard reminders: ${Object.entries(m.process.notices).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
	} else if (view === "cost") {
		body.push(`total $${m.cost.total}; per session ${m.cost.perSession.value === null ? "n/a" : `$${m.cost.perSession.value.toFixed(2)}`} (n=${m.cost.perSession.n}); tokens ${m.totals.tokens}`);
		body.push("cost of sessions loading skill (not caused by it):");
		for (const s of m.cost.bySkill.slice(0, 10)) body.push(`${s.skill}: $${s.cost} over ${s.sessions} sessions`);
	} else if (view === "changes") {
		body.push("newest changes, sessions split at the change time, metric before -> after; flags: small = <20 sessions a side, incomplete = a window runs past the data, confounded = other commits nearby");
		for (const c of m.changes.slice(-8).reverse()) {
			const what = c.package ? `${c.package} ${c.from ?? "-"}->${c.to ?? "-"}` : c.subject.slice(0, 60);
			const i = c.impact;
			const fx = i
				? `sessions ${i.before.sessions}->${i.after.sessions}, tool errors ${pct(i.before.tool_error_rate)}->${pct(i.after.tool_error_rate)}, anchor-first ${pct(i.before.anchor_before_first_edit)}->${pct(i.after.anchor_before_first_edit)}${i.smallSample ? ", small" : ""}${i.incomplete ? `, incomplete (days with data ${i.daysWithData.before}/${i.daysWithData.after})` : ""}${i.confounded ? `, confounded ${i.confounded}` : ""}`
				: "no data before";
			body.push(`${c.at.slice(0, 10)} ${c.kind} ${what}: ${fx}`);
		}
	}
	return bound([...head, ...body, `report: ${reportPath(options.env)}`].join("\n"));
}
