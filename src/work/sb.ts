/**
 * Read-only views of pi-straw-boss state under `<agent dir>/straw-boss`: review threads, car records, and the
 * append-only event ledger. Only ids, names, tags and times are taken; post text is never read past its tag.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { safeName } from "../schema.ts";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const iso = (ms: unknown) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined);

export interface Thread {
	id: string;
	owner: string;
	worker?: string;
	reviewer?: string;
	created?: string;
	/** Producer field (sb 0.94+): the todo uid or `<session8>#<id>` the pair works on. */
	item?: string;
	/** When the thread closed: the producer's `closed`, else the last post when it is `done` or `blocked`. */
	closed?: string;
	closedAs?: "done" | "blocked" | "abandoned";
	/** First `review` post from the worker. */
	firstReview?: string;
	rounds: number;
}

export interface Car {
	coordinator?: string;
	tickets: string[];
	landed?: string;
}

export interface LedgerEvent {
	at: string;
	kind: string;
	id?: string;
	session?: string;
	why?: string;
	item?: string;
	by?: string;
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

function readLines(file: string): Obj[] {
	try {
		return readFileSync(file, "utf8")
			.split("\n")
			.flatMap((line) => {
				if (!line) return [];
				try {
					return [obj(JSON.parse(line))];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	}
}

const list = (dir: string) => {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
};

/** Threads of the sessions whose first 8 characters are in `owners`. */
export function readThreads(sbDir: string, owners: Set<string>): Map<string, Thread[]> {
	const out = new Map<string, Thread[]>();
	const root = join(sbDir, "threads");
	for (const owner8 of list(root)) {
		if (!owners.has(owner8)) continue;
		for (const name of list(join(root, owner8))) {
			const m = name.match(/^(T\d+)\.json$/);
			if (!m) continue;
			const meta = obj(readJson(join(root, owner8, name)));
			const owner = str(meta.owner);
			if (!owner) continue;
			const posts = readLines(join(root, owner8, `${m[1]}.jsonl`));
			const last = posts.at(-1);
			const lastTag = str(last?.tag);
			const firstReview = posts.find((p) => p.tag === "review" && p.from === "worker");
			const closedAs = (str(meta.closedAs) as Thread["closedAs"]) ?? (lastTag === "done" || lastTag === "blocked" ? lastTag : undefined);
			const thread: Thread = {
				id: m[1],
				owner: safeName(owner),
				worker: str(meta.worker) ? safeName(meta.worker) : undefined,
				reviewer: str(meta.reviewer) ? safeName(meta.reviewer) : undefined,
				created: iso(meta.created),
				item: str(meta.item) ? safeName(meta.item) : undefined,
				closed: iso(meta.closed) ?? (closedAs && last ? iso(last.at) : undefined),
				closedAs: iso(meta.closed) ? (closedAs ?? "done") : closedAs,
				firstReview: firstReview ? iso(firstReview.at) : undefined,
				rounds: posts.filter((p) => p.tag === "review").length,
			};
			const bucket = out.get(thread.owner) ?? [];
			bucket.push(thread);
			out.set(thread.owner, bucket);
		}
	}
	return out;
}

/** Car records by coordinator session, with their ticket ids and the time they landed. */
export function readCars(sbDir: string): Map<string, Car[]> {
	const out = new Map<string, Car[]>();
	const root = join(sbDir, "trainboard");
	for (const project of list(root)) {
		const dir = join(root, project, "cars");
		for (const name of list(dir)) {
			if (!name.endsWith(".json") || name.endsWith(".notice.json")) continue;
			const rec = obj(readJson(join(dir, name)));
			const states = Array.isArray(rec.states) ? rec.states.map(obj) : [];
			const coordinator = str(rec.coordinator) ?? str(obj(obj(states[0]).by).session);
			if (!coordinator) continue;
			const landed = states.findLast((s) => s.state === "landed");
			const tickets = Array.isArray(obj(rec.car).tickets) ? (obj(rec.car).tickets as unknown[]).filter((t): t is string => typeof t === "string").map(safeName) : [];
			const car: Car = { coordinator: safeName(coordinator), tickets, landed: str(landed?.at) };
			const bucket = out.get(car.coordinator!) ?? [];
			bucket.push(car);
			out.set(car.coordinator!, bucket);
		}
	}
	return out;
}

/** Ledger events (sb 0.94+) by session, oldest first; an absent ledger is an empty map. */
export function readLedger(sbDir: string): Map<string, LedgerEvent[]> {
	const out = new Map<string, LedgerEvent[]>();
	const dir = join(sbDir, "ledger");
	if (!existsSync(dir)) return out;
	for (const name of list(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()) {
		for (const row of readLines(join(dir, name))) {
			const at = iso(row.at);
			const session = str(row.session);
			if (!at || !session || row.v !== 1) continue;
			const opt = (v: unknown) => (str(v) ? safeName(v) : undefined);
			const event: LedgerEvent = { at, kind: safeName(str(row.kind) ?? "unknown"), id: opt(row.id), session: safeName(session), why: opt(row.why), item: opt(row.item), by: opt(row.by) };
			const bucket = out.get(event.session!) ?? [];
			bucket.push(event);
			out.set(event.session!, bucket);
		}
	}
	for (const events of out.values()) events.sort((a, b) => a.at.localeCompare(b.at));
	return out;
}
