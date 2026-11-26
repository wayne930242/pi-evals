/** Worker thread: extracts the files the main thread sends, one at a time. */
import { parentPort } from "node:worker_threads";
import { extractFile } from "./file.ts";

parentPort?.on("message", async (job: { id: number; path: string; out: string; home: string }) => {
	try {
		const result = await extractFile(job.path, job.out, job.home);
		parentPort?.postMessage({ id: job.id, result });
	} catch (error) {
		parentPort?.postMessage({ id: job.id, error: error instanceof Error ? error.message : String(error) });
	}
});
