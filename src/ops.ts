/** The operations behind `/evals`, `evals_query`, and the CLI. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildIndex, loadIndex, loadRows } from "./build.ts";
import { addMark, readChanges } from "./changes.ts";
import { coverage } from "./coverage.ts";
import { extract, loadCheckpoint, type Progress } from "./extract/run.ts";
import { PRESETS, type Preset, rangeFilter, suffix } from "./ranges.ts";
import { buildModel, type Filter, type ReportModel } from "./model.ts";
import { agentDir, home, layout, loadSettings, stateDir } from "./paths.ts";
import { renderHtml, type Lang } from "./render.ts";

type Env = Record<string, string | undefined>;

export function context(env: Env = process.env) {
	const settings = loadSettings(env);
	const lay = layout(stateDir(env));
	const agent = agentDir(env);
	const roots = [join(agent, "sessions"), ...settings.extraRoots.map((r) => resolve(r))];
	return { settings, layout: lay, agentDir: agent, roots, home: home(env) };
}

export interface StatusFile {
	lastExtract: string;
	stats: { files: number; changed: number; failed: number; bytes: number; records: number; ms: number; mbPerSec: number };
	sessions: { backfill: number; live: number; both: number; subagent: number; linked: number };
	changes: number;
}

export async function runExtract(options: { env?: Env; onProgress?: Progress; signal?: AbortSignal; workers?: number; extraRoots?: string[] } = {}): Promise<StatusFile> {
	const ctx = context(options.env);
	const roots = [...ctx.roots, ...(options.extraRoots ?? []).map((r) => resolve(r))];
	const { stats, checkpoint } = await extract({ roots, layout: ctx.layout, home: ctx.home, workers: options.workers, onProgress: options.onProgress, signal: options.signal });
	const { index, changes, errors } = buildIndex({ layout: ctx.layout, settings: ctx.settings, checkpoint, agentDir: ctx.agentDir });
	const status: StatusFile = {
		lastExtract: checkpoint.lastExtract ?? new Date().toISOString(),
		stats: { ...stats, mbPerSec: stats.ms ? Math.round((stats.bytes / 1e6 / (stats.ms / 1000)) * 10) / 10 : 0 },
		sessions: index.sessions,
		changes: changes.length,
	};
	mkdirSync(join(ctx.layout.state, "index"), { recursive: true });
	writeFileSync(ctx.layout.status, JSON.stringify({ ...status, errors: [...stats.errors, ...errors] }, null, 2));
	return status;
}

export function readStatus(env?: Env): StatusFile | undefined {
	const ctx = context(env);
	return existsSync(ctx.layout.status) ? (JSON.parse(readFileSync(ctx.layout.status, "utf8")) as StatusFile) : undefined;
}

export function coverageNow(env?: Env, cutDays?: number) {
	const ctx = context(env);
	return coverage(ctx.roots, loadCheckpoint(ctx.layout.checkpoint), cutDays ?? ctx.settings.coverageDays);
}

type RangeInput = Filter & { days?: number };
function coverageReader(ctx: ReturnType<typeof context>, now: Date) {
	const activity = new Map<string, { files: number; indexed: number }>();
	const cov = coverage(ctx.roots, loadCheckpoint(ctx.layout.checkpoint), ctx.settings.coverageDays, now.getTime(), activity);
	return (filter: Filter) => {
		const inRange = { files: 0, indexed: 0 };
		for (const [day, a] of activity) if ((!filter.since || day >= filter.since) && (!filter.until || day <= filter.until)) {
			inRange.files += a.files; inRange.indexed += a.indexed;
		}
		return { ...cov, inRange };
	};
}
export function coverageInRange(input: RangeInput, env?: Env) {
	const ctx = context(env), now = new Date(), last = loadIndex(ctx.layout)?.lastExtract;
	const filter = rangeFilter(input, last ?? now.toISOString());
	return { filter, last, coverage: coverageReader(ctx, now)(filter) };
}
function snapshot(env?: Env, withCoverage = true) {
	const ctx = context(env), index = loadIndex(ctx.layout);
	if (!index) return;
	const rows = loadRows(ctx.layout), changes = readChanges(ctx.layout.changes), now = new Date();
	const cov = withCoverage ? coverageReader(ctx, now) : undefined;
	return { index, build(input: RangeInput, preset: Preset, comparisons?: ReportModel["changes"]) {
		const filter = rangeFilter(input, index.lastExtract ?? now.toISOString(), preset);
		return buildModel({ index, rows, changes, comparisons, filter, now, windowDays: ctx.settings.impactWindowDays,
			labelsFile: ctx.layout.labels, sessionEvalsFile: ctx.layout.sessionEvals, coverage: cov?.(filter) });
	} };
}
export function indexedModel(filter: RangeInput, env?: Env, withCoverage = true) {
	const data = snapshot(env, withCoverage);
	return data && { report: data.build(filter, 30), index: data.index };
}

export function model(filter: Filter, env?: Env, withCoverage = true) {
	return indexedModel(filter, env, withCoverage)?.report;
}

/** Builds the report; returns the HTML path, or undefined when nothing was extracted yet. */
export function runReport(options: { env?: Env; filter?: RangeInput; outDir?: string; lang?: Lang } = {}): { html: string; json: string } | undefined {
	const ctx = context(options.env);
	const data = snapshot(options.env), filter = options.filter ?? {};
	if (!data) return;
	const dir = resolve(options.outDir ?? ctx.layout.reports);
	mkdirSync(dir, { recursive: true });
	const write = (m: ReportModel, range: Preset | "custom") => {
		const html = join(dir, `report${suffix(range)}.html`), json = join(dir, `model${suffix(range)}.json`);
		writeFileSync(json, JSON.stringify(m, null, 1));
		writeFileSync(html, renderHtml(m, options.lang ?? "zh", range));
		return { html, json };
	};
	if (filter.since || filter.until || filter.days !== undefined) return write(data.build(filter, 30), "custom");
	const all = data.build(filter, "all");
	for (const p of PRESETS) if (p !== 30) write(p === "all" ? all : data.build(filter, p, all.changes), p);
	return write(data.build(filter, 30, all.changes), 30);
}

export function reportPath(env?: Env): string {
	return join(context(env).layout.reports, "report.html");
}

export function mark(text: string, env?: Env) {
	return addMark(context(env).layout.marks, text);
}

const gb = (b: number) => `${(b / 1e9).toFixed(2)} GB`;

export function statusText(env?: Env): string {
	const ctx = context(env);
	const status = readStatus(env);
	const cov = coverageNow(env);
	const lines = [
		status
			? `last extract ${status.lastExtract}: ${status.stats.changed} of ${status.stats.files} files read (${gb(status.stats.bytes)}, ${status.stats.mbPerSec} MB/s), ${status.stats.records} records, ${status.stats.failed} failed`
			: "no extract yet: run /evals extract",
		status ? `sessions indexed ${status.sessions.backfill} (subagent ${status.sessions.subagent}, linked to parent ${status.sessions.linked}), live-only ${status.sessions.live}, both ${status.sessions.both}; changes ${status.changes}` : "",
		`coverage (inactive > ${cov.cutDays} days): ${cov.indexed.files}/${cov.old.files} indexed (${gb(cov.indexed.bytes)} of ${gb(cov.old.bytes)}); not indexed ${cov.notIndexed.files} (${gb(cov.notIndexed.bytes)}); all files ${cov.all.indexedFiles}/${cov.all.files} indexed`,
		`report: ${existsSync(reportPath(env)) ? reportPath(env) : "not built (run /evals report)"}`,
		`state: ${ctx.layout.state}`,
		ctx.settings.error ? `settings: ${ctx.settings.error}` : "",
	];
	return lines.filter(Boolean).join("\n");
}
