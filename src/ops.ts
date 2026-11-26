/** The operations behind `/evals`, `evals_query`, and the CLI. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildIndex, loadIndex } from "./build.ts";
import { addMark, readChanges } from "./changes.ts";
import { coverage } from "./coverage.ts";
import { extract, loadCheckpoint, type Progress } from "./extract/run.ts";
import { buildModel, type Filter } from "./model.ts";
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
	const { index, changes } = buildIndex({ layout: ctx.layout, settings: ctx.settings, checkpoint, agentDir: ctx.agentDir });
	const status: StatusFile = {
		lastExtract: checkpoint.lastExtract ?? new Date().toISOString(),
		stats: { ...stats, mbPerSec: stats.ms ? Math.round((stats.bytes / 1e6 / (stats.ms / 1000)) * 10) / 10 : 0 },
		sessions: index.sessions,
		changes: changes.length,
	};
	mkdirSync(join(ctx.layout.state, "index"), { recursive: true });
	writeFileSync(ctx.layout.status, JSON.stringify({ ...status, errors: stats.errors }, null, 2));
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

export function model(filter: Filter, env?: Env, withCoverage = true) {
	const ctx = context(env);
	const index = loadIndex(ctx.layout);
	if (!index) return undefined;
	return buildModel({
		index,
		changes: readChanges(ctx.layout.changes),
		filter,
		windowDays: ctx.settings.impactWindowDays,
		labelsFile: ctx.layout.labels,
		sessionEvalsFile: ctx.layout.sessionEvals,
		coverage: withCoverage ? coverageNow(env) : undefined,
	});
}

/** Builds the report; returns the HTML path, or undefined when nothing was extracted yet. */
export function runReport(options: { env?: Env; filter?: Filter; outDir?: string; lang?: Lang } = {}): { html: string; json: string } | undefined {
	const ctx = context(options.env);
	const m = model(options.filter ?? {}, options.env);
	if (!m) return undefined;
	const dir = resolve(options.outDir ?? ctx.layout.reports);
	mkdirSync(dir, { recursive: true });
	const html = join(dir, "report.html");
	const json = join(dir, "model.json");
	writeFileSync(json, JSON.stringify(m, null, 1));
	writeFileSync(html, renderHtml(m, options.lang ?? "zh"));
	return { html, json };
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
	];
	return lines.filter(Boolean).join("\n");
}
