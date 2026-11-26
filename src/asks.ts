/**
 * `asks.jsonl` (append-only): one row per `/ask-ai`, when and where it was asked. Never the question or the answer.
 * The report counts them and how many were followed by a label in the same session within 30 minutes.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { type LabelScope, readLabels } from "./labels.ts";
import { traceId } from "./schema.ts";

export interface AskRow {
	session_id: string;
	at: string;
	kind: "ask_ai";
	project?: string;
	item?: string;
}

/** How long after an ask a label in the same session counts as following it. */
export const ASK_LABEL_WINDOW_MS = 30 * 60 * 1000;

export function appendAsk(file: string, row: AskRow): void {
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${JSON.stringify(row)}\n`);
}

export function readAsks(file: string): AskRow[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				const row = JSON.parse(line) as AskRow;
				return row && row.kind === "ask_ai" && typeof row.session_id === "string" && typeof row.at === "string" ? [row] : [];
			} catch {
				return [];
			}
		});
}

/**
 * Asks in scope (a session in the index belongs by its start; one not indexed yet by the ask's own time and project),
 * and how many a human label in the same session followed within `ASK_LABEL_WINDOW_MS`.
 */
export function asksModel(asksFile: string | undefined, labelsFile: string, scope: LabelScope): { n: number; labelled: number } {
	if (!asksFile) return { n: 0, labelled: 0 };
	const inDates = (at: string) => (!scope.since || at.slice(0, 10) >= scope.since) && (!scope.until || at.slice(0, 10) <= scope.until);
	const asks = readAsks(asksFile).filter((r) => {
		if (!scope.selected) return true;
		const id = traceId(r.session_id, "labels");
		return scope.selected.has(id) || (!scope.indexed?.has(id) && inDates(r.at) && (!scope.project || r.project === scope.project));
	});
	if (!asks.length) return { n: 0, labelled: 0 };
	const labels = readLabels(labelsFile).filter((l) => l.annotator !== "agent" && typeof l.at === "string");
	const labelled = asks.filter((a) => {
		const t = Date.parse(a.at);
		return labels.some((l) => l.session_id === a.session_id && Date.parse(l.at) >= t && Date.parse(l.at) - t <= ASK_LABEL_WINDOW_MS);
	}).length;
	return { n: asks.length, labelled };
}
