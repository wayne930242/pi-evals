/** Appending live records, and reading record files back. */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dayOf } from "./paths.ts";
import type { EvalRecord } from "./schema.ts";

/** An appender that swallows write failures after reporting the first one through `warn`. */
export function liveWriter(eventsDir: string, warn: (message: string) => void, now: () => number = Date.now) {
	let warned = false;
	let made = false;
	return (records: EvalRecord | EvalRecord[]): void => {
		try {
			if (!made) {
				mkdirSync(eventsDir, { recursive: true });
				made = true;
			}
			const list = Array.isArray(records) ? records : [records];
			if (!list.length) return;
			appendFileSync(join(eventsDir, `${dayOf(now())}.jsonl`), list.map((r) => `${JSON.stringify(r)}\n`).join(""));
		} catch (error) {
			if (!warned) {
				warned = true;
				warn(`pi-evals: cannot write records (${error instanceof Error ? error.message : String(error)}); later failures in this session stay silent.`);
			}
		}
	};
}

/** Records in one JSONL file; malformed lines are skipped. */
export function readRecords(file: string): EvalRecord[] {
	if (!existsSync(file)) return [];
	const out: EvalRecord[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		try {
			out.push(JSON.parse(line) as EvalRecord);
		} catch {}
	}
	return out;
}

/** Live record files, oldest first. */
export function liveFiles(eventsDir: string): string[] {
	if (!existsSync(eventsDir)) return [];
	return readdirSync(eventsDir)
		.filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
		.sort()
		.map((name) => join(eventsDir, name));
}
