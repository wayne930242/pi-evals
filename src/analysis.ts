/**
 * The analysis scripts' logic (scripts/*.mjs are thin wrappers): freshness, disagree, by-version, sample and
 * label-import. Each reads the index, checkpoint, labels or change timeline and returns lines; none prints message
 * text or a label's note.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRows } from "./build.ts";
import { readChanges, versionAt } from "./changes.ts";
import { DETECTORS, ERA_START } from "./detectors.ts";
import { type Checkpoint, EXTRACTOR_VERSION, loadCheckpoint } from "./extract/run.ts";
import { appendLabel, cleanNote, FAILURE_TYPES, type FailureType, type LabelRow, readLabels, RULES } from "./labels.ts";
import { DETECTOR_META } from "./meta.ts";
import type { Layout } from "./paths.ts";
import { safeName } from "./schema.ts";
import { ANCHORLOOP } from "./work/join.ts";

export class AnalysisError extends Error {}
export interface Result { lines: string[]; status?: number }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const pct = (num: number, den: number) => (den ? `${((100 * num) / den).toFixed(1)}%` : "n/a");

function checkpointOf(lay: Layout): Checkpoint {
	if (!existsSync(lay.checkpoint)) throw new AnalysisError("No checkpoint. Run /evals extract first.");
	return loadCheckpoint(lay.checkpoint);
}

function lastExtractOf(lay: Layout, cp: Checkpoint): string | undefined {
	try {
		return (JSON.parse(readFileSync(lay.status, "utf8")) as { lastExtract?: string }).lastExtract ?? cp.lastExtract;
	} catch {
		return cp.lastExtract;
	}
}

/** Last extract, summaries per extractor version, and signs of a run stopped part-way; status 1 when versions are mixed. */
export function freshness(lay: Layout, now = Date.now()): Result {
	const cp = checkpointOf(lay);
	const last = lastExtractOf(lay, cp);
	const by = new Map<string, number>();
	for (const f of Object.values(cp.files)) {
		const key = f.extractor === undefined ? "unstamped (0.6.0 or older)" : String(f.extractor);
		by.set(key, (by.get(key) ?? 0) + 1);
	}
	const lines = [`last extract ${last ?? "never"}${last ? ` (${((now - Date.parse(last)) / 3_600_000).toFixed(1)} h ago)` : ""}`, `this pi-evals writes extractor ${EXTRACTOR_VERSION}`];
	for (const [version, n] of [...by].sort()) lines.push(`extractor ${version}: ${plural(n, "summary", "summaries")}`);
	const saved = statSync(lay.checkpoint).mtimeMs;
	if (last && saved > Date.parse(last) + 120_000) lines.push("The checkpoint was saved after the last finished extract: a run stopped part-way.");
	if (existsSync(lay.days) && last) {
		const built = (JSON.parse(readFileSync(lay.days, "utf8")) as { built?: string }).built;
		if (built && built < last) lines.push(`The index (built ${built}) is older than the last extract: run /evals extract to rebuild it.`);
	}
	const mixed = [...by.keys()].some((v) => v !== String(EXTRACTOR_VERSION));
	if (mixed) lines.push(`STALE: some summaries are from another extractor version. Run /evals extract to finish; do not read the numbers until this passes.`);
	else lines.push("Fresh: every summary is from the current extractor.");
	return { lines, status: mixed ? 1 : 0 };
}

const sourceOf = (r: LabelRow) => (r.source === "live" ? "live" : r.source === "live-prompt" ? "prompt" : "after");

/** Code verdicts and explanations by session id, with each session's start. */
function verdicts(cp: Checkpoint, rule: string): Map<string, { label: string; why: string; start: string }> {
	const out = new Map<string, { label: string; why: string; start: string }>();
	for (const f of Object.values(cp.files)) {
		const r = f.summary.evals[rule as keyof typeof f.summary.evals];
		if (r) out.set(f.summary.sessionId, { label: r.label, why: r.explanation, start: f.summary.start });
	}
	return out;
}

/** Per labelled session, the user's verdict in effect against the code's, and which way the disagreements lean. */
export function disagree(lay: Layout, rule: string, rangeDays?: number): Result {
	if (!(DETECTORS as readonly string[]).includes(rule)) throw new AnalysisError(`Unknown rule. Rules: ${DETECTORS.join(", ")}.`);
	const cp = checkpointOf(lay);
	const code = verdicts(cp, rule);
	const last = Date.parse(lastExtractOf(lay, cp) ?? new Date().toISOString());
	const rows = readLabels(lay.labels).filter((r) => r.annotator !== "agent" && r.evaluation_name === rule && !r.undo);
	let agree = 0, unclear = 0, noCode = 0, under = 0, over = 0;
	const listed: string[] = [];
	for (const r of rows) {
		const c = code.get(r.session_id);
		if (rangeDays !== undefined && (!c || Date.parse(c.start) < last - rangeDays * 86_400_000)) continue;
		if (r.label === "unclear") { unclear += 1; continue; }
		if (!c || c.label === "na") { noCode += 1; continue; }
		if (c.label === r.label) { agree += 1; continue; }
		if (c.label === "fail") under += 1;
		else over += 1;
		listed.push(`${safeName(r.session_id)} human ${r.label}, code ${c.label} (${safeName(c.why)}), ${sourceOf(r)}`);
	}
	const lean = !listed.length ? "No disagreements." : under === over ? "The disagreements split evenly." : under > over
		? "Most disagreements are code fail / human pass: the detector undercounts; its rate is too low."
		: "Most disagreements are code pass / human fail: the detector overcounts; its rate is too high.";
	return {
		lines: [
			`${rule}${rangeDays !== undefined ? ` (sessions of the last ${rangeDays} days)` : ""}: ${agree + listed.length} labelled, ${agree} agree, ${listed.length} disagree; unclear ${unclear}; no code verdict ${noCode}`,
			...listed,
			`code fail / human pass: ${under} (detector undercounts)`,
			`code pass / human fail: ${over} (detector overcounts)`,
			lean,
		],
	};
}

const numeric = (v: string) => (/^\d+(\.\d+)*$/.test(v) ? v.split(".").map(Number) : undefined);
function byVersionOrder(a: string, b: string): number {
	const x = numeric(a), y = numeric(b);
	if (!x || !y) return x ? -1 : y ? 1 : a.localeCompare(b);
	for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
	return 0;
}

/** A detector's pass rate per version of a package at each session's start. */
export function byVersion(lay: Layout, detector: string, pkg?: string): Result {
	if (!(DETECTORS as readonly string[]).includes(detector)) throw new AnalysisError(`Unknown detector. Detectors: ${DETECTORS.join(", ")}.`);
	const names = pkg ? [pkg] : DETECTOR_META[detector]?.introducedIn ? [DETECTOR_META[detector].introducedIn!.package] : ANCHORLOOP;
	const changes = readChanges(lay.changes);
	const cells = new Map<string, { pass: number; n: number }>();
	for (const r of loadRows(lay)) {
		const v = r.ev[detector];
		if (v === undefined) continue;
		const version = versionAt(changes, names, r.s) ?? "unknown";
		const cell = cells.get(version) ?? { pass: 0, n: 0 };
		cell.pass += v;
		cell.n += 1;
		cells.set(version, cell);
	}
	if (!cells.size) return { lines: [`${detector} by ${names[0]} version: no judged sessions in the index.`] };
	return {
		lines: [
			`${detector} by ${names[0]} version at session start (pass / judged):`,
			...[...cells].sort(([a], [b]) => byVersionOrder(a, b)).map(([v, c]) => `${v}: ${c.pass}/${c.n} ${pct(c.pass, c.n)}`),
			"Versions differ in time as well as code: other changes landed in the same days.",
		],
	};
}

/** Small seeded generator (mulberry32). */
function random(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const sizeOf = (calls: number) => (calls < 20 ? "small" : calls < 100 ? "medium" : "large");

/** A stratified sample of judged sessions the user has not labelled yet, written to `<state>/labels/sample-<date>.json`. */
export function sample(lay: Layout, n: number, options: { since?: string; seed?: number; now?: Date } = {}): Result {
	if (!Number.isSafeInteger(n) || n < 1 || n > 500) throw new AnalysisError("n must be 1 to 500.");
	const since = options.since ?? ERA_START;
	if (!Number.isFinite(Date.parse(since))) throw new AnalysisError("--since must be an ISO time.");
	const now = options.now ?? new Date();
	const seed = options.seed ?? Number(now.toISOString().slice(0, 10).replaceAll("-", ""));
	const labelled = new Set(readLabels(lay.labels).filter((r) => r.annotator !== "agent").map((r) => r.session_id));
	type Row = { session_id: string; project: string; kind: string; model: string; start: string; tool_calls: number; size: string };
	const strata = new Map<string, Row[]>();
	const seen = new Set<string>();
	let judged = 0;
	for (const f of Object.values(checkpointOf(lay).files)) {
		const s = f.summary;
		if (!s.sessionId || seen.has(s.sessionId) || labelled.has(s.sessionId) || s.start < since) continue;
		seen.add(s.sessionId);
		if (!Object.values(s.evals).some((r) => r && r.label !== "na")) continue;
		judged += 1;
		const row = { session_id: s.sessionId, project: s.project, kind: s.kind, model: safeName(s.model ?? "unknown"), start: s.start, tool_calls: s.toolCalls, size: sizeOf(s.toolCalls) };
		const key = `${row.project}|${row.kind}|${row.model}|${row.size}`;
		strata.set(key, [...(strata.get(key) ?? []), row]);
	}
	const next = random(seed);
	const shuffle = <T>(list: T[]) => {
		for (let i = list.length - 1; i > 0; i--) {
			const j = Math.floor(next() * (i + 1));
			[list[i], list[j]] = [list[j], list[i]];
		}
		return list;
	};
	const groups = shuffle([...strata.keys()].sort()).map((k) => shuffle([...strata.get(k)!].sort((a, b) => a.session_id.localeCompare(b.session_id))));
	const chosen: (Row & { n: number })[] = [];
	while (chosen.length < n && groups.some((g) => g.length)) {
		for (const g of groups) if (g.length && chosen.length < n) chosen.push({ n: chosen.length + 1, ...g.pop()! });
	}
	const dir = join(lay.state, "labels");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `sample-${now.toISOString().slice(0, 10)}.json`);
	writeFileSync(file, `${JSON.stringify(chosen, null, 1)}\n`);
	const tally = (key: "kind" | "size" | "project") => [...new Set(chosen.map((c) => c[key]))].map((v) => `${v} ${chosen.filter((c) => c[key] === v).length}`).join(", ");
	return {
		lines: [
			`${chosen.length} of ${judged} judged, unlabelled sessions since ${since} (${strata.size} strata by project, kind, model, size; seed ${seed}; labelled sessions left out)`,
			`kind: ${tally("kind")}`,
			`size: ${tally("size")}`,
			`projects: ${new Set(chosen.map((c) => c.project)).size}`,
			`sample: ${file}`,
		],
	};
}

/** The newest `sample-*.json` under `<state>/labels`. */
function latestSample(lay: Layout): string {
	const dir = join(lay.state, "labels");
	const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^sample-.*\.json$/.test(f)).sort() : [];
	if (!files.length) throw new AnalysisError("No sample under <state>/labels; run the sample script or pass --sample.");
	return join(dir, files.at(-1)!);
}

/**
 * Form answers (`- <n>_<rule>: pass|fail|unclear`, `- <n>_type: <failure type>`, `- <n>_note: ...`) become after-the-fact
 * human rows, appended to labels.jsonl; a later import of the same session and rule replaces the earlier in effect.
 */
export function labelImport(lay: Layout, answerFile: string, sampleFile?: string, at = new Date().toISOString()): Result {
	let answer: string;
	let entries: { n?: number; session_id?: string }[];
	try {
		answer = readFileSync(answerFile, "utf8");
	} catch {
		throw new AnalysisError("Cannot read the answer file.");
	}
	try {
		entries = JSON.parse(readFileSync(sampleFile ?? latestSample(lay), "utf8"));
	} catch (error) {
		throw error instanceof AnalysisError ? error : new AnalysisError("Cannot read the sample file.");
	}
	const sessionOf = (n: number) => entries.find((e) => e.n === n)?.session_id ?? (entries.some((e) => e.n !== undefined) ? undefined : entries[n - 1]?.session_id);
	const fields = new Map<string, string>();
	let current: string | undefined;
	for (const line of answer.split("\n")) {
		const m = /^- ([A-Za-z0-9_]+): ?(.*)$/.exec(line);
		if (m) fields.set((current = m[1]), m[2]);
		else if (/^Other comments:/.test(line)) current = undefined;
		else if (current !== undefined && line !== "") fields.set(current, `${fields.get(current)}\n${line}`);
	}
	const rules = RULES.filter((r) => r !== "other") as string[];
	const rows: LabelRow[] = [];
	const problems: string[] = [];
	const noted = new Set<number>();
	for (const [name, raw] of fields) {
		const m = /^(\d+)_([a-z_]+)$/.exec(name);
		if (!m || !rules.includes(m[2])) continue;
		const n = Number(m[1]);
		const session = sessionOf(n);
		if (!session) { problems.push(`${name}: no session #${n} in the sample`); continue; }
		const label = raw.trim();
		if (!label) continue;
		if (label !== "pass" && label !== "fail" && label !== "unclear") { problems.push(`${name}: unknown verdict`); continue; }
		const row: LabelRow = { session_id: session, evaluation_name: m[2], label, at, annotator: "human", source: "batch" };
		const type = fields.get(`${n}_type`)?.trim();
		if (type && label === "fail") {
			if ((FAILURE_TYPES as readonly string[]).includes(type)) row.type = type as FailureType;
			else problems.push(`${n}_type: unknown failure type`);
		}
		const note = cleanNote(fields.get(`${n}_note`));
		if (note && !noted.has(n)) { row.note = note; noted.add(n); }
		rows.push(row);
	}
	for (const row of rows) appendLabel(lay.labels, row);
	const per = new Map<string, number>();
	for (const r of rows) per.set(r.evaluation_name, (per.get(r.evaluation_name) ?? 0) + 1);
	return {
		lines: [
			`wrote ${plural(rows.length, "label", "labels")} (after the fact, human) to labels.jsonl${per.size ? `: ${[...per].map(([k, v]) => `${k} ${v}`).join(", ")}` : ""}`,
			...problems.map((p) => `warning: ${p}`),
			"A later import of the same session and rule replaces this one; labels.jsonl keeps both.",
		],
		status: rows.length ? 0 : 1,
	};
}

/** The session file holding a session id, from the checkpoint. */
export function sessionFile(lay: Layout, id: string): string {
	for (const [path, f] of Object.entries(checkpointOf(lay).files)) if (f.summary.sessionId === id) return path;
	throw new AnalysisError("No such session in the index.");
}
