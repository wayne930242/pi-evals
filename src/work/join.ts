/**
 * Joins each session's rebuilt work items with what other records know about them: the exact cost of the subagents
 * that did the work, the review thread and car that closed it, the sb ledger's waits, and the size of the change.
 * Writes `index/items.json` (what the report reads) and `pi.workitem` / `pi.stall` records (docs/schema.md).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionSummary } from "../aggregate.ts";
import { type Change, versionAt } from "../changes.ts";
import type { Layout } from "../paths.ts";
import { type EvalRecord, NAMES, record, spanId } from "../schema.ts";
import { type Car, type LedgerEvent, readCars, readLedger, readThreads, type Thread } from "./sb.ts";
import type { Gap, ItemRaw, SessionWork, StallKind } from "./track.ts";

export const ANCHORLOOP = ["pi-anchorloop", "pi-aaaav", "aaaav"];
export type CloseKind = "review_done" | "landed" | "wrap" | "evidence" | "unproven" | "deleted" | "open";
export const CLOSE_KINDS: CloseKind[] = ["review_done", "landed", "wrap", "evidence", "unproven", "deleted", "open"];
export const STALL_KINDS: StallKind[] = ["human", "peer", "child", "timer", "ci", "device"];

export interface Stall {
	kind: StallKind;
	on?: string;
	start: string;
	end: string;
	/** Milliseconds of this gap inside the item's active window. */
	ms: number;
	via: Gap["via"];
}

export interface WorkItem {
	key: string;
	title: string;
	owner?: string;
	project: string;
	session: string;
	/** Every session the item ran in (one, unless a uid or an import carried it on). */
	sessions: string[];
	level: "top" | "nested";
	status: ItemRaw["status"];
	created: string;
	start?: string;
	close?: string;
	activeMs: number;
	closeKind: CloseKind;
	/** When the closing signal happened: the reviewer's `done`, the car landing, or the wrap. */
	closeAt?: string;
	thread?: string;
	evidence: number;
	blockedBy: number;
	/** Estimated: the main's cost in the window, split evenly among items active at the same moment. */
	mainCost: number;
	/** Exact: the whole cost of every subagent session joined to the item. */
	childCost: number;
	children: string[];
	/** `delegated` when a subagent did (part of) the work, else `self`. */
	kind: "delegated" | "self";
	role: string;
	model?: string;
	anchorloop?: string;
	lines?: number;
	stalls: Stall[];
	stallMs: Partial<Record<StallKind, number>>;
	/** For an item still open when its session file ends: since when it waits, and on what. */
	open?: { since: string; kind: StallKind | "working"; on?: string };
	lastActivity: string;
}

export interface ItemsFile {
	v: 1;
	built: string;
	items: WorkItem[];
	/** Main cost outside every item window, per session (for the attribution card). */
	sessions: { id: string; project: string; last: string; unattributed: number }[];
}

interface Child {
	id: string;
	name?: string;
	cost: number;
	role: string;
	model: string;
	at: string;
	cwd?: string;
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;
const ms = (iso?: string) => (iso ? Date.parse(iso) : Number.NaN);
const TICKET = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const prefixOf = (owner?: string) => (owner && owner.includes("-") ? owner.slice(0, owner.lastIndexOf("-")) : undefined);
const short = (session: string) => session.slice(0, 8);

function atomicWrite(file: string, text: string) {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, file);
}

/** Lines changed between two commits, by `git diff --numstat`, cached on disk; numbers only. */
export class Lines {
	private cache: { repo: Record<string, string>; miss: Record<string, string>; diff: Record<string, number | null> };
	private file: string;
	private now: Date;
	constructor(file: string, now: Date) {
		this.file = file;
		this.now = now;
		const raw = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Partial<Lines["cache"]>) : {};
		this.cache = { repo: raw.repo ?? {}, miss: raw.miss ?? {}, diff: raw.diff ?? {} };
	}
	private git(dir: string, args: string[]) {
		return spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 64 << 20 });
	}
	/** The first candidate repository holding `sha`. Misses are re-checked after a day. */
	repoOf(sha: string, dirs: string[]): string | undefined {
		const hit = this.cache.repo[sha];
		if (hit) return hit;
		const missed = this.cache.miss[sha];
		if (missed && this.now.getTime() - Date.parse(missed) < 86_400_000) return undefined;
		for (const dir of dirs) {
			if (!existsSync(dir)) continue;
			if (this.git(dir, ["cat-file", "-e", `${sha}^{commit}`]).status === 0) {
				this.cache.repo[sha] = dir;
				return dir;
			}
		}
		this.cache.miss[sha] = this.now.toISOString();
		return undefined;
	}
	/** Added plus deleted lines from `base` to `head`, or undefined when `base` is not an ancestor of `head`. */
	between(dir: string, base: string, head: string): number | undefined {
		const key = `${dir}|${base}|${head}`;
		if (key in this.cache.diff) return this.cache.diff[key] ?? undefined;
		let n: number | null = null;
		if (this.git(dir, ["merge-base", "--is-ancestor", base, head]).status === 0) {
			const res = this.git(dir, ["diff", "--numstat", base, head]);
			if (res.status === 0) {
				n = 0;
				for (const line of res.stdout.split("\n")) {
					const [a, d] = line.split("\t");
					if (/^\d+$/.test(a ?? "") && /^\d+$/.test(d ?? "")) n += Number(a) + Number(d);
				}
			}
		}
		this.cache.diff[key] = n;
		return n ?? undefined;
	}
	save() {
		atomicWrite(this.file, JSON.stringify(this.cache));
	}
}

function refineGap(gap: Gap, events: LedgerEvent[] | undefined): { kind: StallKind; on?: string } {
	if (!events?.length) return { kind: gap.kind, on: gap.on };
	const lo = ms(gap.start) - 2000;
	const hi = ms(gap.end) + 5000;
	const kinds: Record<string, [StallKind, string]> = {
		wait_answered: ["human", "W"],
		wait_returned: ["human", "W"],
		wait_parked: ["human", "W"],
		link_wait_done: ["device", "L"],
		thread_close: ["child", "T"],
	};
	let best: LedgerEvent | undefined;
	for (const e of events) {
		const t = ms(e.at);
		if (t >= lo && t <= hi && kinds[e.kind]) best = e;
	}
	if (!best) return { kind: gap.kind, on: gap.on };
	const [kind, prefix] = kinds[best.kind];
	const id = best.id ?? "";
	return { kind, on: id ? (/^\d+$/.test(id) ? `${prefix}${id}` : id) : gap.on };
}

/** An open wait in the ledger for this session at its end: a wait card, a link wait, or a review thread. */
function openWait(events: LedgerEvent[] | undefined): { kind: StallKind; on?: string } | undefined {
	if (!events?.length) return undefined;
	const open = new Map<string, { kind: StallKind; on?: string }>();
	const pairs: Record<string, [string, StallKind] | undefined> = { wait_raised: ["W", "human"], link_wait_open: ["L", "device"], thread_open: ["T", "child"] };
	const ends = new Set(["wait_answered", "wait_returned", "wait_parked", "link_wait_done", "thread_close"]);
	for (const e of events) {
		const id = e.id ?? "";
		const open_ = pairs[e.kind];
		if (open_) open.set(`${open_[0]}:${id}`, { kind: open_[1], on: /^\d+$/.test(id) ? `${open_[0]}${id}` : id || undefined });
		else if (ends.has(e.kind)) for (const k of [...open.keys()]) if (k.endsWith(`:${id}`)) open.delete(k);
	}
	return [...open.values()].at(-1);
}

/** Picks one item for a child among candidates: the one whose window holds the launch, else the closest start before it. */
function byTime(items: ItemRaw[], at: string, end: string): ItemRaw | undefined {
	const t = ms(at);
	const inside = items.filter((it) => t >= ms(it.created) && t <= ms(it.close ?? end));
	if (inside.length) return inside.at(-1);
	const before = items.filter((it) => ms(it.created) <= t).sort((a, b) => ms(b.created) - ms(a.created));
	return before[0] ?? items[0];
}

/** The children of one session: each child belongs to one parent, the one its brief names, else the one that spawned it. */
function childrenOf(s: SessionSummary, parentOf: Map<string, string>, byLogical: Map<string, SessionSummary>): Child[] {
	const launches = new Map((s.work?.launches ?? []).map((l) => [l.id, l]));
	const ids = new Set([...s.spawned.map((sp) => sp.id), ...[...parentOf].filter(([, p]) => p === s.sessionId).map(([id]) => id)]);
	const out: Child[] = [];
	for (const id of ids) {
		if (parentOf.get(id) !== s.sessionId) continue;
		const c = byLogical.get(id);
		const l = launches.get(id);
		out.push({ id, name: c?.childName ?? l?.name, cost: c?.cost ?? 0, role: l?.role ?? "unknown", model: c?.model ?? l?.model ?? "unknown", at: l?.at ?? c?.start ?? s.start, cwd: c?.cwd });
	}
	return out;
}

export function joinWork(options: { summaries: SessionSummary[]; changes: Change[]; sbDir: string; repos: string[]; lines?: Lines; now: Date }): ItemsFile {
	const { summaries, changes } = options;
	const withWork = summaries.filter((s) => s.work?.items.length);
	const parentOf = new Map<string, string>();
	const byLogical = new Map<string, SessionSummary>();
	for (const s of summaries) for (const sp of s.spawned) parentOf.set(sp.id, s.sessionId);
	for (const s of summaries) {
		if (s.kind !== "subagent") continue;
		if (s.logicalId) byLogical.set(s.logicalId, s);
		if (s.logicalId && s.parentId) parentOf.set(s.logicalId, s.parentId);
	}
	const threads = readThreads(options.sbDir, new Set(withWork.map((s) => short(s.sessionId))));
	const cars = readCars(options.sbDir);
	const ledger = readLedger(options.sbDir);
	const out: WorkItem[] = [];
	const sessions: ItemsFile["sessions"] = [];
	for (const s of withWork) {
		const work = s.work as SessionWork;
		const end = work.lastActivity;
		sessions.push({ id: s.sessionId, project: s.project, last: end, unattributed: work.unattributed });
		// A task carried in already done is no item here, so it must not win a thread or a child either.
		const top = work.items.filter((it) => it.level === "top" && !it.carried);
		const children = childrenOf(s, parentOf, byLogical);
		const sessionThreads = threads.get(s.sessionId) ?? [];
		const pairs = new Map(work.pairs.map((p) => [p.thread, p]));
		const itemOf = (it: ItemRaw) => new Set([it.key, it.uid, `${short(s.sessionId)}#${it.id}`].filter(Boolean) as string[]);
		// Threads: the producer's item link, else the worker named as the item's owner.
		const threadOf = new Map<ItemRaw, Thread>();
		for (const th of sessionThreads) {
			const item = th.item ?? pairs.get(th.id)?.item;
			let target = item ? top.find((it) => itemOf(it).has(item)) : undefined;
			if (!target && th.worker) {
				const owned = top.filter((it) => it.owner === th.worker);
				target = owned.length ? byTime(owned, th.created ?? end, end) : undefined;
			}
			if (target && !threadOf.has(target)) threadOf.set(target, th);
		}
		// Children: the strongest link wins (launch item, evidence ref, thread pair, owner name, reviewer prefix).
		const childCost = new Map<ItemRaw, { cost: number; names: string[]; owner?: Child }>();
		for (const c of children) {
			const launchItem = work.launches.find((l) => l.id === c.id)?.item;
			const levels: ((it: ItemRaw) => boolean)[] = [
				(it) => (!!launchItem && itemOf(it).has(launchItem)) || it.refs.includes(`child:${c.id}`),
				(it) => {
					const th = threadOf.get(it);
					return !!th && !!c.name && (th.reviewer === c.name || th.worker === c.name);
				},
				(it) => !!c.name && it.owner === c.name,
				(it) => {
					const p = prefixOf(it.owner);
					return !!p && !!c.name && new RegExp(`^${p.replace(/[.+]/g, "\\$&")}-review\\d*$`).test(c.name);
				},
			];
			let target: ItemRaw | undefined;
			for (const match of levels) {
				const hits = top.filter(match);
				if (hits.length) {
					target = byTime(hits, c.at, end);
					break;
				}
			}
			if (!target) continue;
			const row = childCost.get(target) ?? { cost: 0, names: [] };
			row.cost += c.cost;
			if (c.name && !row.names.includes(c.name)) row.names.push(c.name);
			if (c.name && c.name === target.owner) row.owner = c;
			else row.owner ??= c;
			childCost.set(target, row);
		}
		// Size: lines from the last evidence commit of the item before (same repository) to this item's last.
		const repos = [s.cwd, ...children.map((c) => c.cwd), ...options.repos].filter((d): d is string => !!d).filter((d, i, a) => a.indexOf(d) === i);
		const lines = new Map<ItemRaw, number>();
		if (options.lines) {
			const prev = new Map<string, string>();
			for (const it of [...top].filter((i) => i.shas.length).sort((a, b) => ms(a.close ?? end) - ms(b.close ?? end))) {
				const located = it.shas.map((sha) => [sha, options.lines!.repoOf(sha, repos)] as const);
				const head = located.findLast(([, repo]) => repo);
				if (head) {
					const repo = head[1]!;
					const own = located.filter(([, r]) => r === repo).map(([sha]) => sha);
					const base = prev.get(repo) ?? (own.length > 1 ? own[0] : undefined);
					if (base && base !== head[0]) {
						const n = options.lines.between(repo, base, head[0]);
						if (n !== undefined) lines.set(it, n);
					}
				}
				for (const [sha, repo] of located) if (repo) prev.set(repo, sha);
			}
		}
		const carsHere = cars.get(s.sessionId) ?? [];
		const events = ledger.get(s.sessionId);
		const pendingChildren = (names: string[]) =>
			names.filter((name) => {
				const evs = work.childEvents.filter((e) => e[1] === name);
				const launched = work.launches.filter((l) => l.name === name).map((l) => l.at);
				const lastStart = [...launched, ...evs.filter((e) => e[2] === "resume").map((e) => e[0])].sort().at(-1);
				const lastResult = evs.filter((e) => e[2] === "result").map((e) => e[0]).sort().at(-1);
				return !!lastStart && (!lastResult || lastResult < lastStart);
			});
		for (const it of work.items) {
			// Closed before this session saw it: its close belongs to the session (or tool) that closed it.
			if (it.carried) continue;
			const kids = it.level === "top" ? childCost.get(it) : undefined;
			const th = threadOf.get(it);
			const activeMs = it.active.reduce((sum, [a, b]) => sum + Math.max(0, ms(b ?? end) - ms(a)), 0);
			let closeKind: CloseKind = it.status === "deleted" ? "deleted" : it.status === "completed" ? "unproven" : "open";
			let closeAt: string | undefined;
			if (it.status === "completed" && it.close) {
				const close = ms(it.close);
				const from = ms(it.start ?? it.created);
				const tickets = new Set(it.title.match(TICKET) ?? []);
				const landed = carsHere.find((c) => c.landed && ms(c.landed) >= from && ms(c.landed) <= close + 300_000 && (!tickets.size || c.tickets.some((t) => tickets.has(t))));
				const wrap = work.wraps.find((w) => w.wrapped && ms(w.at) >= close - 120_000 && ms(w.at) <= close + 600_000) ?? events?.find((e) => e.kind === "wrap" && e.why === "wrapped" && ms(e.at) >= close - 120_000 && ms(e.at) <= close + 600_000);
				if (th?.closedAs === "done" && th.closed && ms(th.closed) <= close + 300_000) {
					closeKind = "review_done";
					closeAt = th.closed;
				} else if (landed) {
					closeKind = "landed";
					closeAt = landed.landed;
				} else if (wrap) {
					closeKind = "wrap";
					closeAt = wrap.at;
				} else if (it.evidence > 0) closeKind = "evidence";
			}
			const stalls: Stall[] = it.stalls.map(([gi, n]) => {
				const gap = work.gaps[gi];
				return { ...refineGap(gap, events), start: gap.start, end: gap.end, ms: n, via: gap.via };
			});
			const stallMs: WorkItem["stallMs"] = {};
			for (const st of stalls) stallMs[st.kind] = (stallMs[st.kind] ?? 0) + st.ms;
			let open: WorkItem["open"];
			if (it.status === "in_progress") {
				const pending = pendingChildren(kids?.names ?? []);
				const ledgerWait = openWait(events);
				const since = work.idleSince ?? end;
				if (pending.length) open = { since, kind: "child", on: pending.at(-1) };
				else if (ledgerWait) open = { since, ...ledgerWait };
				else open = work.idleSince ? { since, kind: "human" } : { since, kind: "working" };
			}
			const ownerChild = kids?.owner;
			out.push({
				key: it.key,
				title: it.title,
				owner: it.owner,
				project: s.project,
				session: s.sessionId,
				sessions: [s.sessionId],
				level: it.level,
				status: it.status,
				created: it.created,
				start: it.start,
				close: it.close,
				activeMs,
				closeKind,
				closeAt,
				thread: th?.id,
				evidence: it.evidence,
				blockedBy: it.blockedBy,
				mainCost: it.mainCost,
				childCost: round(kids?.cost ?? 0),
				children: kids?.names ?? [],
				kind: kids?.names.length ? "delegated" : "self",
				role: ownerChild ? ownerChild.role : "self",
				model: ownerChild ? ownerChild.model : s.model,
				anchorloop: versionAt(changes, ANCHORLOOP, it.start ?? it.created),
				lines: lines.get(it),
				stalls,
				stallMs,
				open,
				lastActivity: end,
			});
		}
	}
	options.lines?.save();
	return { v: 1, built: options.now.toISOString(), items: mergeByKey(out), sessions };
}

/** One item per key: a uid or an import carries the same item into another session. */
function mergeByKey(items: WorkItem[]): WorkItem[] {
	const by = new Map<string, WorkItem[]>();
	for (const it of items) by.set(it.key, [...(by.get(it.key) ?? []), it]);
	const out: WorkItem[] = [];
	for (const group of by.values()) {
		if (group.length === 1) {
			out.push(group[0]);
			continue;
		}
		group.sort((a, b) => a.lastActivity.localeCompare(b.lastActivity));
		// The close, its kind, signal and thread come from the copy that closed the item, not from the newest copy.
		const closing = group.filter((g) => g.status === "completed" || g.status === "deleted").sort((a, b) => (a.close ?? "").localeCompare(b.close ?? "")).at(-1);
		const newest = group.at(-1)!;
		const reopened = closing && newest.status === "in_progress" && (newest.start ?? "") > (closing.close ?? "");
		const last = closing && !reopened ? closing : newest;
		const starts = group.map((g) => g.start).filter((x): x is string => !!x).sort();
		const stallMs: WorkItem["stallMs"] = {};
		for (const g of group) for (const [k, v] of Object.entries(g.stallMs) as [StallKind, number][]) stallMs[k] = (stallMs[k] ?? 0) + v;
		out.push({
			...last,
			sessions: group.map((g) => g.session),
			created: group.map((g) => g.created).sort()[0],
			start: starts[0],
			activeMs: group.reduce((s, g) => s + g.activeMs, 0),
			mainCost: round(group.reduce((s, g) => s + g.mainCost, 0)),
			childCost: round(group.reduce((s, g) => s + g.childCost, 0)),
			children: [...new Set(group.flatMap((g) => g.children))],
			kind: group.some((g) => g.kind === "delegated") ? "delegated" : "self",
			stalls: group.flatMap((g) => g.stalls),
			stallMs,
			evidence: Math.max(...group.map((g) => g.evidence)),
		});
	}
	return out.sort((a, b) => (a.start ?? a.created).localeCompare(b.start ?? b.created));
}

/** `pi.workitem` and `pi.stall` records for the joined items. */
export function workRecords(file: ItemsFile): EvalRecord[] {
	const out: EvalRecord[] = [];
	for (const it of file.items) {
		const base = { "session.id": it.session, "pi.project": it.project, "pi.item.key": it.key };
		out.push(
			record({
				name: NAMES.workitem,
				kind: "span",
				ts: it.start ?? it.created,
				end_ts: it.close,
				duration_ms: it.activeMs,
				source: "backfill",
				span_id: spanId(it.session, `item:${it.key}`),
				attrs: {
					...base,
					"pi.item.title": it.title,
					"pi.item.owner": it.owner,
					"pi.item.level": it.level,
					"pi.item.status": it.status,
					"pi.item.created": it.created,
					"pi.item.close_kind": it.closeKind,
					"pi.item.thread": it.thread,
					"pi.item.evidence_n": it.evidence,
					"pi.item.blocked_by_n": it.blockedBy,
					"pi.usage.cost_usd": it.mainCost,
					"pi.item.child_cost_usd": it.childCost,
					"pi.item.children": it.children,
					"pi.item.lines_changed": it.lines,
					"pi.item.sessions": it.sessions.length > 1 ? it.sessions : undefined,
				},
			}),
		);
		for (const st of it.stalls) {
			out.push(record({ name: NAMES.stall, kind: "span", ts: st.start, end_ts: st.end, duration_ms: st.ms, source: "backfill", attrs: { ...base, "pi.stall.kind": st.kind, "pi.stall.on": st.on, "pi.stall.via": st.via } }));
		}
	}
	return out;
}

export function writeWork(layout: Layout, file: ItemsFile): void {
	atomicWrite(layout.items, JSON.stringify(file));
	atomicWrite(layout.itemRecords, workRecords(file).map((r) => `${JSON.stringify(r)}\n`).join(""));
}

export function loadWork(layout: Layout): ItemsFile | undefined {
	return existsSync(layout.items) ? (JSON.parse(readFileSync(layout.items, "utf8")) as ItemsFile) : undefined;
}

export const sbDirOf = (agentDir: string) => join(agentDir, "straw-boss");
