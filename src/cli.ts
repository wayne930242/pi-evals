#!/usr/bin/env node
/** Thin CLI over the same operations as `/evals`. */
import { context, mark, runExtract, runReport, statusText } from "./ops.ts";
import { query, type View, VIEWS } from "./query.ts";

const USAGE = `usage:
  pi-evals extract [--root <dir>]... [--workers <n>] [--json]
  pi-evals report [--out <dir>] [--since YYYY-MM-DD | --days N] [--project <key>] [--lang zh|en]
  pi-evals status
  pi-evals query <${VIEWS.join("|")}> [--since YYYY-MM-DD] [--project <key>]
  pi-evals mark <note>`;

function flag(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

function flags(args: string[], name: string): string[] {
	return args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
}

async function main(argv: string[]): Promise<number> {
	const [cmd, ...args] = argv;
	const settingsError = context().settings.error;
	if (settingsError) process.stderr.write(`pi-evals settings: ${settingsError}\n`);
	if (cmd === "extract") {
		const json = args.includes("--json");
		const workers = flag(args, "--workers");
		let lastPrint = 0;
		const status = await runExtract({
			extraRoots: flags(args, "--root"),
			workers: workers === undefined ? undefined : Number(workers),
			onProgress: (done, total, bytes) => {
				const now = Date.now();
				if (now - lastPrint < 500 && done !== total) return;
				lastPrint = now;
				if (json) process.stdout.write(`${JSON.stringify({ progress: { done, total, bytes } })}\n`);
				else process.stderr.write(`\rextract ${done}/${total} files, ${(bytes / 1e9).toFixed(2)} GB   `);
			},
		});
		if (json) process.stdout.write(`${JSON.stringify({ result: status })}\n`);
		else {
			process.stderr.write("\n");
			const s = status.stats;
			console.log(`read ${s.changed} of ${s.files} files (${(s.bytes / 1e9).toFixed(2)} GB) in ${(s.ms / 1000).toFixed(1)} s, ${s.mbPerSec} MB/s; ${s.records} records; ${s.failed} failed`);
			console.log(`sessions ${status.sessions.backfill} indexed (subagent ${status.sessions.subagent}, linked ${status.sessions.linked}), live-only ${status.sessions.live}; changes ${status.changes}`);
		}
		return status.stats.failed ? 2 : 0;
	}
	if (cmd === "report") {
		const lang = flag(args, "--lang") === "en" ? "en" : "zh";
		const out = runReport({ outDir: flag(args, "--out"), filter: { since: flag(args, "--since"), days: args.includes("--days") ? Number(flag(args, "--days")) : undefined, project: flag(args, "--project") }, lang });
		if (!out) {
			console.error("nothing extracted yet: run pi-evals extract");
			return 1;
		}
		console.log(out.html);
		console.log(out.json);
		return 0;
	}
	if (cmd === "status") {
		console.log(statusText());
		return 0;
	}
	if (cmd === "query") {
		const view = args[0] as View;
		if (!VIEWS.includes(view)) {
			console.error(USAGE);
			return 1;
		}
		console.log(query(view, { since: flag(args, "--since"), project: flag(args, "--project") }));
		return 0;
	}
	if (cmd === "mark" && args.length) {
		const change = mark(args.join(" "));
		console.log(`marked ${change.at}`);
		return 0;
	}
	console.error(USAGE);
	return cmd === "help" || cmd === "--help" ? 0 : 1;
}

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(error) => {
		console.error(error instanceof Error ? error.stack : error);
		process.exit(1);
	},
);
