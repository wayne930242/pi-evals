/**
 * Builds the index from back-fill summaries and live records: per-day, per-project aggregates (days.json),
 * per-session detector results for the labels join (session-evals.json), the change timeline, and a status file.
 * Live records fill what session files lack; for a session both sources saw, back-fill counts win and live adds
 * monitor lifecycles and ask-user answer sources.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { addLabel, bucketOf, bump, type DayAgg, emptyDay, mergeDay, rowOf, type SessionRow, type SessionSummary } from "./aggregate.ts";
import { buildChanges, type Change, versionAt, writeChanges } from "./changes.ts";
import type { Checkpoint } from "./extract/run.ts";
import { dayOf, type Layout, type Settings } from "./paths.ts";
import { type EvalRecord, NAMES, traceId } from "./schema.ts";
import { liveFiles, readRecords } from "./store.ts";
import { ANCHORLOOP, joinWork, Lines, sbDirOf, writeWork } from "./work/join.ts";

export interface DaysIndex {
	v: 1;
	built: string;
	lastExtract?: string;
	/** day → project → aggregates */
	days: Record<string, Record<string, DayAgg>>;
	/** tool → owner package (newest live snapshot), with version when known. */
	owners: Record<string, { owner: string; version?: string }>;
	/** Skills pi offered in the newest sessions (union of catalogs seen in the last 7 days of data, and live snapshots). */
	offeredSkills: string[];
	sessions: { backfill: number; live: number; both: number; subagent: number; linked: number };
	/** First and last session start in the index, and the last extract: the range the data covers. */
	range: { start: string; end: string };
}

export const ANCHORLOOP_PACKAGES = ANCHORLOOP;

function atomicWrite(file: string, text: string) {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, file);
}

/** Live records grouped by session id. */
function liveSessions(layout: Layout): { bySession: Map<string, EvalRecord[]>; snapshots: EvalRecord[] } {
	const bySession = new Map<string, EvalRecord[]>();
	const snapshots: EvalRecord[] = [];
	for (const file of liveFiles(layout.events)) {
		for (const rec of readRecords(file)) {
			const id = String(rec.attrs?.["session.id"] ?? "");
			if (!id) continue;
			if (rec.name === NAMES.tools) snapshots.push(rec);
			const list = bySession.get(id);
			if (list) list.push(rec);
			else bySession.set(id, [rec]);
		}
	}
	return { bySession, snapshots };
}

const dayAgg = (days: Record<string, DayAgg>, ts: string) => (days[dayOf(ts)] ??= emptyDay());

/** Aggregates from live records alone, for a session no session file covers (e.g. `--no-session`). */
export function liveSummary(records: EvalRecord[]): { project: string; start: string; days: Record<string, DayAgg> } {
	const days: Record<string, DayAgg> = {};
	const start = records.reduce((min, r) => (r.ts < min ? r.ts : min), records[0]?.ts ?? new Date(0).toISOString());
	const project = String(records[0]?.attrs["pi.project"] ?? "unknown");
	const loaded = new Set<string>();
	for (const r of records) {
		const a = r.attrs;
		if (r.name === NAMES.tool) {
			const day = dayAgg(days, r.end_ts ?? r.ts);
			const name = String(a["gen_ai.tool.name"]);
			const t = (day.tools[name] ??= { calls: 0, errors: 0, durSum: 0, durN: 0 });
			t.calls += 1;
			if (a["error.type"]) t.errors += 1;
			if (typeof r.duration_ms === "number") {
				t.durSum += r.duration_ms;
				t.durN += 1;
			}
			if (a["pi.ask_user.source"] !== undefined) addAsk(day, r);
			if (name === "subagent" && a["gen_ai.agent.name"]) bump(day.subagents, `${a["gen_ai.agent.name"]}|${a["gen_ai.request.model"]}`);
		} else if (r.name === NAMES.skill) {
			const day = dayAgg(days, r.ts);
			const skill = String(a["gen_ai.skill.name"]);
			bump(day.skills, skill);
			bump(day.skillTriggers, String(a["pi.skill.trigger"]));
			loaded.add(skill);
		} else if (r.name === NAMES.prompt) dayAgg(days, r.ts).prompts += 1;
		else if (r.name === NAMES.monitor) addMonitor(dayAgg(days, r.end_ts ?? r.ts), r);
	}
	const first = dayAgg(days, start);
	first.sessions += 1;
	if (records.some((r) => r.name === NAMES.session && r.attrs["pi.session.kind"] === "subagent")) first.subagentSessions += 1;
	for (const skill of loaded) bump(first.skillSessions, skill);
	return { project, start, days };
}

function addAsk(day: DayAgg, r: EvalRecord) {
	const a = r.attrs;
	day.ask.calls += 1;
	if (a["pi.ask_user.cancelled"] === true) day.ask.cancelled += 1;
	if (a["error.type"]) day.ask.errors += 1;
	bump(day.ask.sources, String(a["pi.ask_user.source"]));
	if (typeof r.duration_ms === "number" && !a["error.type"]) {
		day.ask.durSum += r.duration_ms;
		day.ask.durN += 1;
		day.ask.buckets[bucketOf(r.duration_ms)] += 1;
	}
}

function addMonitor(day: DayAgg, r: EvalRecord) {
	day.monitors.finished += 1;
	bump(day.monitors.statuses, String(r.attrs["pi.monitor.status"] ?? "unknown"));
	if (typeof r.duration_ms === "number") {
		day.monitors.durSum += r.duration_ms;
		day.monitors.durN += 1;
	}
}

/** Back-fill days of one session with live-only facts laid over: monitor lifecycles and ask-user answer sources. */
export function overlayLive(days: Record<string, DayAgg>, records: EvalRecord[]): Record<string, DayAgg> {
	const out: Record<string, DayAgg> = structuredClone(days);
	const monitors = records.filter((r) => r.name === NAMES.monitor);
	if (monitors.length) {
		for (const day of Object.values(out)) day.monitors = { started: day.monitors.started, finished: 0, statuses: {}, durSum: 0, durN: 0 };
		for (const r of monitors) addMonitor(dayAgg(out, r.end_ts ?? r.ts), r);
	}
	for (const r of records) {
		const source = r.attrs["pi.ask_user.source"];
		if (r.name !== NAMES.tool || typeof source !== "string") continue;
		const day = dayAgg(out, r.end_ts ?? r.ts);
		if ((day.ask.sources.unknown ?? 0) > 0) {
			day.ask.sources.unknown -= 1;
			bump(day.ask.sources, source);
		}
	}
	return out;
}

/** child logical id → parent session id and the role and model it was launched with. */
export function subagentLinks(summaries: SessionSummary[], ledgerDir: string): Map<string, { parent: string; role: string; model: string }> {
	const links = new Map<string, { parent: string; role: string; model: string }>();
	if (existsSync(ledgerDir)) {
		for (const name of readdirSync(ledgerDir).filter((n) => n.endsWith(".json"))) {
			try {
				const rows = JSON.parse(readFileSync(join(ledgerDir, name), "utf8")) as { id?: string; agent?: string; model?: string }[];
				if (!Array.isArray(rows)) continue;
				for (const row of rows) if (row?.id) links.set(row.id, { parent: name.slice(0, -5), role: row.agent ?? "unknown", model: row.model ?? "unknown" });
			} catch {}
		}
	}
	for (const s of summaries) for (const child of s.spawned) links.set(child.id, { parent: s.sessionId, role: child.role, model: child.model });
	return links;
}

export function buildIndex(options: { layout: Layout; settings: Settings; checkpoint: Checkpoint; agentDir: string; now?: () => Date }): {
	index: DaysIndex;
	changes: Change[];
	errors: string[];
} {
	const { layout, checkpoint } = options;
	const { bySession, snapshots } = liveSessions(layout);
	const errors: string[] = [];
	const changes = buildChanges(options.settings.changeRepos, snapshots, layout.marks, errors);
	writeChanges(layout.changes, changes);

	const summaries = Object.values(checkpoint.files).map((f) => f.summary);
	const links = subagentLinks(summaries, join(options.agentDir, "dispatch-ledger"));
	const cube: DaysIndex["days"] = {};
	const add = (project: string, days: Record<string, DayAgg>) => {
		for (const [day, agg] of Object.entries(days)) {
			const byProject = (cube[day] ??= {});
			byProject[project] = mergeDay(byProject[project] ?? emptyDay(), agg);
		}
	};
	const versionFor = (start: string) => versionAt(changes, ANCHORLOOP_PACKAGES, start) ?? "unknown";
	const rows: SessionRow[] = [];
	const sessionEvals: Record<string, Record<string, string>> = {};
	const seen = new Set<string>();
	let both = 0;
	let linked = 0;
	let subagent = 0;
	for (const s of summaries) {
		if (!s.sessionId || seen.has(s.sessionId)) continue;
		seen.add(s.sessionId);
		const live = bySession.get(s.sessionId);
		const days = live ? overlayLive(s.days, live) : structuredClone(s.days);
		if (live) both += 1;
		const startDay = dayOf(s.start || 0);
		const first = (days[startDay] ??= emptyDay());
		if (s.kind === "subagent") {
			subagent += 1;
			const link = s.logicalId ? links.get(s.logicalId) : undefined;
			if (link || s.parentId) linked += 1;
			bump(first.subagentCost, link?.role ?? (s.parentId ? "role-unknown" : "unlinked"), s.cost);
		}
		const version = versionFor(s.start);
		const labels: Record<string, string> = {};
		for (const [name, result] of Object.entries(s.evals)) {
			if (!result || result.explanation === "out_of_scope_pre_3.0") continue;
			addLabel(first.detectorVersions, `${name}|${version}`, result.label);
			labels[name] = result.label;
		}
		if (Object.keys(labels).length) sessionEvals[s.sessionId] = labels;
		add(s.project, days);
		rows.push({ ...rowOf(s.start, s.project, s.kind === "subagent", s.cost, days, s.evals), id: traceId(s.sessionId, "labels"),
			linked: s.kind === "subagent" ? Boolean(s.parentId || (s.logicalId && links.has(s.logicalId))) : undefined });
	}
	let liveOnly = 0;
	for (const [id, records] of bySession) {
		if (seen.has(id)) continue;
		liveOnly += 1;
		const summary = liveSummary(records);
		add(summary.project, summary.days);
		rows.push({ ...rowOf(summary.start, summary.project, records.some((r) => r.name === NAMES.session && r.attrs["pi.session.kind"] === "subagent"), 0, summary.days), id: traceId(id, "labels"), linked: false });
	}

	const owners: DaysIndex["owners"] = {};
	for (const rec of [...snapshots].sort((a, b) => a.ts.localeCompare(b.ts))) {
		const tools = rec.attrs["pi.tools"];
		if (!Array.isArray(tools)) continue;
		for (const entry of tools) {
			const eq = entry.indexOf("=");
			const owner = entry.slice(eq + 1);
			const at = owner.lastIndexOf("@");
			owners[entry.slice(0, eq)] = at > 0 ? { owner: owner.slice(0, at), version: owner.slice(at + 1) } : { owner };
		}
	}

	const allDays = Object.keys(cube).sort();
	const lastDay = allDays.at(-1) ?? "";
	rows.sort((a, b) => a.s.localeCompare(b.s));
	const cutoff = lastDay ? dayOf(Date.parse(lastDay) - 7 * 86_400_000) : "";
	const offered = new Set<string>();
	for (const cat of Object.values(checkpoint.catalogs)) if (cat.last.slice(0, 10) >= cutoff) for (const n of cat.names) offered.add(n);
	for (const rec of bySession.values()) for (const r of rec) if (r.name === NAMES.skills && Array.isArray(r.attrs["pi.skills"])) for (const n of r.attrs["pi.skills"]) offered.add(n);

	const index: DaysIndex = {
		v: 1,
		built: (options.now?.() ?? new Date()).toISOString(),
		lastExtract: checkpoint.lastExtract,
		days: cube,
		owners,
		offeredSkills: [...offered].sort(),
		sessions: { backfill: seen.size, live: liveOnly, both, subagent, linked },
		range: { start: rows[0]?.s ?? "", end: checkpoint.lastExtract ?? rows.at(-1)?.s ?? "" },
	};
	atomicWrite(layout.days, JSON.stringify(index));
	atomicWrite(layout.sessionRows, JSON.stringify(rows));
	atomicWrite(layout.sessionEvals, JSON.stringify(sessionEvals));
	const now = options.now?.() ?? new Date();
	try {
		const work = joinWork({ summaries, changes, sbDir: sbDirOf(options.agentDir), repos: options.settings.changeRepos, lines: new Lines(layout.lines, now), now });
		writeWork(layout, work);
	} catch (error) {
		errors.push(`work items: ${error instanceof Error ? error.message : String(error)}`);
	}
	return { index, changes, errors };
}

export function loadRows(layout: Layout): SessionRow[] {
	return existsSync(layout.sessionRows) ? (JSON.parse(readFileSync(layout.sessionRows, "utf8")) as SessionRow[]) : [];
}

export function loadIndex(layout: Layout): DaysIndex | undefined {
	if (!existsSync(layout.days)) return undefined;
	return JSON.parse(readFileSync(layout.days, "utf8")) as DaysIndex;
}
