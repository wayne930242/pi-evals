/** Incremental back-fill over session roots: only files whose size or mtime changed are read again. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import type { SessionSummary } from "../aggregate.ts";
import type { Layout } from "../paths.ts";
import { fileKey } from "../schema.ts";
import { extractFile, type FileResult } from "./file.ts";

export interface FileEntry {
	size: number;
	mtimeMs: number;
	key: string;
	month: string;
	summary: SessionSummary;
}

/** Bump when extraction changes what it derives; a checkpoint from another version re-reads every file. */
export const EXTRACTOR_VERSION = 5;

export interface Checkpoint {
	v: 1;
	extractor?: number;
	files: Record<string, FileEntry>;
	/** Skill catalogs by hash, with the newest session start that offered each. */
	catalogs: Record<string, { names: string[]; last: string }>;
	lastExtract?: string;
}

export interface ExtractStats {
	files: number;
	changed: number;
	failed: number;
	bytes: number;
	records: number;
	ms: number;
	errors: string[];
}

export type Progress = (done: number, total: number, bytes: number) => void;

export function loadCheckpoint(file: string): Checkpoint {
	if (!existsSync(file)) return { v: 1, extractor: EXTRACTOR_VERSION, files: {}, catalogs: {} };
	const raw = JSON.parse(readFileSync(file, "utf8")) as Checkpoint;
	if (raw.v !== 1) throw new Error(`pi-evals: unknown checkpoint version ${raw.v} in ${file}`);
	return raw;
}

export function saveCheckpoint(file: string, checkpoint: Checkpoint): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(checkpoint));
	renameSync(tmp, file);
}

/** Every `*.jsonl` under the roots (any depth), with size and mtime. Sidecars and missing roots are skipped. */
export function listSessionFiles(roots: string[]): { path: string; size: number; mtimeMs: number }[] {
	const out: { path: string; size: number; mtimeMs: number }[] = [];
	const walk = (dir: string) => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				try {
					const st = statSync(path);
					out.push({ path, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
				} catch {}
			}
		}
	};
	for (const root of roots) walk(root);
	return out;
}

const monthOf = (path: string) => path.match(/(\d{4}-\d{2})-\d{2}T/)?.[1] ?? "unknown";

const workerUrl = () => new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url);

/** Runs `jobs` on a pool of worker threads, or in this thread when `workers` is 0. */
async function runPool(
	jobs: { path: string; out: string }[],
	home: string,
	workers: number,
	onDone: (job: { path: string; out: string }, result: FileResult | undefined, error?: string) => void,
	signal?: AbortSignal,
): Promise<void> {
	if (workers <= 0) {
		for (const job of jobs) {
			if (signal?.aborted) return;
			try {
				onDone(job, await extractFile(job.path, job.out, home));
			} catch (error) {
				onDone(job, undefined, error instanceof Error ? error.message : String(error));
			}
		}
		return;
	}
	let next = 0;
	const pool = Array.from({ length: Math.min(workers, jobs.length) }, () => new Worker(workerUrl()));
	try {
		await Promise.all(
			pool.map(
				(worker) =>
					new Promise<void>((resolve, reject) => {
						const pump = () => {
							if (signal?.aborted || next >= jobs.length) return resolve();
							const id = next++;
							worker.once("message", (msg: { id: number; result?: FileResult; error?: string }) => {
								onDone(jobs[id], msg.result, msg.error);
								pump();
							});
							worker.postMessage({ id, ...jobs[id], home });
						};
						worker.once("error", reject);
						pump();
					}),
			),
		);
	} finally {
		await Promise.all(pool.map((w) => w.terminate()));
	}
}

export async function extract(options: {
	roots: string[];
	layout: Layout;
	home: string;
	workers?: number;
	onProgress?: Progress;
	signal?: AbortSignal;
	now?: () => Date;
}): Promise<{ stats: ExtractStats; checkpoint: Checkpoint }> {
	const started = Date.now();
	const checkpoint = loadCheckpoint(options.layout.checkpoint);
	const files = listSessionFiles(options.roots);
	const rereadAll = checkpoint.extractor !== EXTRACTOR_VERSION;
	checkpoint.extractor = EXTRACTOR_VERSION;
	const changed = files.filter((f) => {
		const known = checkpoint.files[f.path];
		if (rereadAll) return true;
		return !known || known.size !== f.size || known.mtimeMs !== f.mtimeMs;
	});
	const stats: ExtractStats = { files: files.length, changed: changed.length, failed: 0, bytes: 0, records: 0, ms: 0, errors: [] };
	const byPath = new Map(changed.map((f) => [f.path, f]));
	const jobs = changed
		.sort((a, b) => a.size - b.size)
		.map((f) => {
			const key = fileKey(f.path);
			const month = monthOf(f.path);
			return { path: f.path, out: join(options.layout.records, month, `${key}.jsonl`) };
		});
	let done = 0;
	let sinceSave = 0;
	const workers = options.workers ?? Math.max(1, Math.min(8, availableParallelism() - 1));
	options.onProgress?.(0, jobs.length, 0);
	await runPool(
		jobs,
		options.home,
		jobs.length < 4 ? 0 : workers,
		(job, result, error) => {
			const file = byPath.get(job.path);
			done += 1;
			if (file) stats.bytes += file.size;
			if (!result || !file) {
				stats.failed += 1;
				if (stats.errors.length < 20) stats.errors.push(`${job.path}: ${error ?? "no result"}`);
			} else {
				stats.records += result.records;
				const key = fileKey(file.path);
				checkpoint.files[file.path] = { size: file.size, mtimeMs: file.mtimeMs, key, month: monthOf(file.path), summary: result.summary };
				if (result.catalog?.length) {
					const hash = createHash("sha1").update(result.catalog.join("\n")).digest("hex").slice(0, 16);
					result.summary.catalog = hash;
					const seen = checkpoint.catalogs[hash];
					if (!seen || seen.last < result.summary.start) checkpoint.catalogs[hash] = { names: result.catalog, last: result.summary.start };
				}
			}
			if (++sinceSave >= 1000) {
				sinceSave = 0;
				saveCheckpoint(options.layout.checkpoint, checkpoint);
			}
			options.onProgress?.(done, jobs.length, stats.bytes);
		},
		options.signal,
	);
	checkpoint.lastExtract = (options.now?.() ?? new Date()).toISOString();
	saveCheckpoint(options.layout.checkpoint, checkpoint);
	stats.ms = Date.now() - started;
	return { stats, checkpoint };
}
