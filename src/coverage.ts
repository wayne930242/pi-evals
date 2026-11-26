/** The cleanup gate: how many session files older than the cut are fully indexed, by count and bytes. */
import type { Checkpoint } from "./extract/run.ts";
import { listSessionFiles } from "./extract/run.ts";

export interface Coverage {
	cutDays: number;
	cutoff: string;
	old: { files: number; bytes: number };
	indexed: { files: number; bytes: number };
	notIndexed: { files: number; bytes: number };
	all: { files: number; bytes: number; indexedFiles: number };
	/** Session files the index still holds whose source file is gone. */
	retainedGone: number;
}

export function coverage(roots: string[], checkpoint: Checkpoint, cutDays: number, now = Date.now()): Coverage {
	const cutoff = now - cutDays * 86_400_000;
	const files = listSessionFiles(roots);
	const result: Coverage = {
		cutDays,
		cutoff: new Date(cutoff).toISOString(),
		old: { files: 0, bytes: 0 },
		indexed: { files: 0, bytes: 0 },
		notIndexed: { files: 0, bytes: 0 },
		all: { files: files.length, bytes: 0, indexedFiles: 0 },
		retainedGone: 0,
	};
	const present = new Set<string>();
	for (const f of files) {
		present.add(f.path);
		result.all.bytes += f.size;
		const known = checkpoint.files[f.path];
		const fresh = !!known && known.size === f.size && known.mtimeMs === f.mtimeMs;
		if (fresh) result.all.indexedFiles += 1;
		if (f.mtimeMs >= cutoff) continue;
		result.old.files += 1;
		result.old.bytes += f.size;
		const side = fresh ? result.indexed : result.notIndexed;
		side.files += 1;
		side.bytes += f.size;
	}
	for (const path of Object.keys(checkpoint.files)) if (!present.has(path)) result.retainedGone += 1;
	return result;
}
