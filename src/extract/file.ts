/** Extracting one session file: stream its lines, write its records next to the index, return its summary. */
import { createReadStream, mkdirSync, openSync, renameSync, writeSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { SessionSummary } from "../aggregate.ts";
import type { EvalRecord } from "../schema.ts";
import { SessionReader } from "./session.ts";

export interface FileResult {
	summary: SessionSummary;
	catalog?: string[];
	records: number;
}

/** Reads `path` (never writes it) and writes its records to `out` atomically. */
export async function extractFile(path: string, out: string, home: string): Promise<FileResult> {
	mkdirSync(dirname(out), { recursive: true });
	const tmp = `${out}.${process.pid}.tmp`;
	const fd = openSync(tmp, "w");
	let buffer: string[] = [];
	let count = 0;
	const flush = () => {
		if (buffer.length) writeSync(fd, buffer.join(""));
		buffer = [];
	};
	const emit = (r: EvalRecord) => {
		buffer.push(`${JSON.stringify(r)}\n`);
		count += 1;
		if (buffer.length >= 500) flush();
	};
	try {
		const reader = new SessionReader(path, home, emit);
		const lines = createInterface({ input: createReadStream(path, { highWaterMark: 1 << 20 }), crlfDelay: Number.POSITIVE_INFINITY });
		for await (const line of lines) reader.feedLine(line);
		const { summary, catalog } = reader.finish();
		flush();
		closeSync(fd);
		renameSync(tmp, out);
		return { summary, catalog, records: count };
	} catch (error) {
		try {
			closeSync(fd);
		} catch {}
		throw error;
	}
}
