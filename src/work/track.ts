/**
 * Work items of one session, rebuilt from its `todo/v1` snapshots (pi-todo-ledger), plus the facts the join needs:
 * the main's cost over time, its idle gaps and what woke it, and the subagents, review pairs and wraps it started.
 *
 * An item is one todo task from its `in_progress` transition to `completed`, `deleted` or the end of the session.
 * Snapshots are diffed along the entry tree, so a `/tree` branch or a `clear` never merges two tasks that share an id:
 * the branch that ends with the last snapshot in the file wins, and each task id gets a new item whenever it reappears.
 * Only the subject leaves this module as text, cut to 80 characters (`titleOf`); every other string is a name.
 */
import { safeName, titleOf } from "../schema.ts";

export { titleOf };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** A main idle this long or longer is a stall. */
export const STALL_MS = 120_000;

export type StallKind = "human" | "peer" | "child" | "timer" | "ci" | "device";
export type ItemStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface Gap {
	/** ISO start (the main's turn ended, or a blocking question was asked) and end (what woke it). */
	start: string;
	end: string;
	kind: StallKind;
	/** Who or what, when the waking entry names it: a subagent name, a peer's session (first 13 characters), or (from the sb ledger) `W12`, `L340`, `T5`. */
	on?: string;
	/** `ask` when the main sat inside a question tool, else `idle`. */
	via: "idle" | "ask";
}

export interface ItemRaw {
	key: string;
	id: number;
	title: string;
	owner?: string;
	uid?: string;
	/** Session the task was imported from (todo `origin.session`). */
	origin?: string;
	/** `nested` when the session is itself a subagent: a sub-item of the parent's item, not counted on its own. */
	level: "top" | "nested";
	status: ItemStatus;
	created: string;
	start?: string;
	close?: string;
	/** Intervals in `in_progress`; an open end is null (still active when the session file ends). */
	active: [string, string | null][];
	evidence: number;
	/** Distinct evidence commit shas, in order. */
	shas: string[];
	/** Evidence `ref` values of the form `child:<subagent id>`. */
	refs: string[];
	blockedBy: number;
	/** Main cost inside the active window, split evenly among the items active at the same moment. */
	mainCost: number;
	/** Gap index → milliseconds of that gap inside this item's active window. */
	stalls: [number, number][];
}

export interface Launch {
	id: string;
	name?: string;
	role: string;
	model: string;
	item?: string;
	at: string;
}

export interface SessionWork {
	items: ItemRaw[];
	gaps: Gap[];
	launches: Launch[];
	/** Subagent results and resumes by name: [ts, "result" | "resume"]. */
	childEvents: [string, string, "result" | "resume"][];
	pairs: { thread: string; worker?: string; reviewer?: string; item?: string; at: string }[];
	wraps: { at: string; wrapped: boolean }[];
	/** The main ended its last turn here and nothing woke it before the file ends. */
	idleSince?: string;
	lastActivity: string;
	/** Main cost outside every item window. */
	unattributed: number;
}

interface TaskLite {
	id: number;
	status: ItemStatus;
	title: string;
	owner?: string;
	uid?: string;
	origin?: string;
	evidence: number;
	shas: string[];
	refs: string[];
	blockedBy: number;
}

interface Snapshot {
	entry: string;
	ts: string;
	pred: number;
	tasks: TaskLite[];
}

const CHILD_REF = /^child:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUSES = new Set(["pending", "in_progress", "completed", "deleted"]);

function liteOf(raw: unknown): TaskLite | undefined {
	const t = obj(raw);
	if (typeof t.id !== "number" || !Number.isInteger(t.id)) return undefined;
	const status = (STATUSES.has(String(t.status)) ? t.status : "pending") as ItemStatus;
	const evidence = Array.isArray(t.evidence) ? t.evidence.map(obj) : [];
	const shas: string[] = [];
	for (const e of evidence) {
		const sha = str(e.sha);
		if (sha && /^[0-9a-f]{6,40}$/i.test(sha) && !shas.includes(sha)) shas.push(sha);
	}
	// Only a `child:<subagent id>` ref is kept: it joins the child to the item. A tool call id needs no storing.
	const refs = evidence.map((e) => str(e.ref)).filter((r): r is string => !!r && CHILD_REF.test(r));
	const uid = str(t.uid);
	const origin = str(obj(t.origin).session);
	return {
		id: t.id,
		status,
		title: titleOf(t.subject),
		owner: str(t.owner) ? safeName(t.owner) : undefined,
		uid: uid ? safeName(uid) : undefined,
		origin: origin ? safeName(origin) : undefined,
		evidence: evidence.length,
		shas,
		refs,
		blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy.length : 0,
	};
}

/** The kind of stall a waking entry ends, or undefined when the entry does not start a turn. */
export function wakeOf(entry: Obj): { kind: StallKind; on?: string } | undefined {
	const type = entry.type;
	if (type === "thinking_level_change" || type === "model_change") return { kind: "human" };
	if (type === "message") return obj(entry.message).role === "user" ? { kind: "human" } : undefined;
	if (type !== "custom_message") return undefined;
	const details = obj(entry.details);
	switch (entry.customType) {
		case "better-show":
		case "robot-hand-follow-up":
		case "robot-hand-herdr":
			return { kind: "human" };
		case "intercom_message": {
			const from = str(obj(details.from).id);
			return { kind: "peer", on: from ? peerName(from) : undefined };
		}
		case "straw-tower":
			return details.kind === "intercom" ? { kind: "peer", on: peerName(str(obj(details.from).id) ?? "") || undefined } : { kind: "timer" };
		case "straw-link":
			return { kind: "device" };
		case "subagent_result":
		case "subagent_ping":
		case "subagent_status":
		case "subagent_stop":
		case "subagent-accept-check":
		case "straw-boss-orphan-result":
		case "straw-boss-child-revived": {
			const name = str(details.name);
			return { kind: "child", on: name ? safeName(name) : undefined };
		}
		case "pi-loop-monitor": {
			if (details.deliveryGroup === "monitor-started") return undefined;
			const source = str(obj(details.trigger).source) ?? "";
			return details.deliveryGroup === "monitor-terminal" || source.startsWith("monitor:") ? { kind: "ci" } : { kind: "timer" };
		}
		case "straw-auto":
		case "straw-boss-wrap":
		case "straw-boss-watch":
			return { kind: "timer" };
		default:
			return undefined;
	}
}

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;
/** A peer session by its first 13 characters: UUIDv7 sessions started within the same minute share the first 8. */
const peerName = (id: string) => (UUIDISH.test(id) ? id.slice(0, 13) : safeName(id));

export class WorkTracker {
	private snaps: Snapshot[] = [];
	/** entry id → index of the newest todo snapshot on its path (or -1). */
	private todoAt = new Map<string, number>();
	private costs: [number, number][] = [];
	private gaps: Gap[] = [];
	private idleFrom?: string;
	private launches: Launch[] = [];
	private childEvents: SessionWork["childEvents"] = [];
	private pairs: SessionWork["pairs"] = [];
	private wraps: SessionWork["wraps"] = [];
	private last = "";

	/** Every entry, in file order, before it is otherwise handled. */
	entry(entry: Obj, ts: string): void {
		if (ts && ts > this.last) this.last = ts;
		const id = str(entry.id);
		const parent = str(entry.parentId);
		const inherited = parent !== undefined ? (this.todoAt.get(parent) ?? -1) : this.snaps.length - 1;
		if (entry.type === "custom" && entry.customType === "todo/v1") {
			const data = obj(entry.data);
			if (Array.isArray(data.tasks)) {
				const tasks = data.tasks.map(liteOf).filter((t): t is TaskLite => !!t);
				this.snaps.push({ entry: id ?? String(this.snaps.length), ts, pred: inherited, tasks });
				if (id) this.todoAt.set(id, this.snaps.length - 1);
				return;
			}
		}
		if (id) this.todoAt.set(id, inherited);
		if (this.idleFrom && ts) {
			const wake = wakeOf(entry);
			if (wake) {
				this.gap(this.idleFrom, ts, wake.kind, wake.on, "idle");
				this.idleFrom = undefined;
			}
		}
	}

	assistant(ts: string, cost: number, stopReason: unknown): void {
		if (cost) this.costs.push([Date.parse(ts), cost]);
		// A turn that started from an entry we do not classify: its idle time is not a stall of a known kind.
		this.idleFrom = typeof stopReason === "string" && stopReason !== "toolUse" ? ts : undefined;
	}

	/** A question tool held the main for `start`..`end`. */
	wait(start: string, end: string, kind: StallKind): void {
		this.gap(start, end, kind, undefined, "ask");
	}

	launch(l: Launch): void {
		this.launches.push(l);
	}

	child(ts: string, name: string, what: "result" | "resume"): void {
		this.childEvents.push([ts, safeName(name), what]);
	}

	pair(p: SessionWork["pairs"][number]): void {
		this.pairs.push(p);
	}

	wrap(at: string, wrapped: boolean): void {
		this.wraps.push({ at, wrapped });
	}

	private gap(start: string, end: string, kind: StallKind, on: string | undefined, via: Gap["via"]) {
		if (Date.parse(end) - Date.parse(start) >= STALL_MS) this.gaps.push({ start, end, kind, on, via });
	}

	finish(session: string, nested: boolean): SessionWork | undefined {
		const items = this.items(session, nested);
		if (!items.length && !this.launches.length && !this.pairs.length) return undefined;
		const end = Date.parse(this.last);
		const spans = items.map((it) => it.active.map(([a, b]) => [Date.parse(a), b ? Date.parse(b) : end + 1] as const));
		let unattributed = 0;
		for (const [t, cost] of this.costs) {
			const on = spans.flatMap((s, i) => (s.some(([a, b]) => t >= a && t < b) ? [i] : []));
			if (!on.length) unattributed += cost;
			for (const i of on) items[i].mainCost += cost / on.length;
		}
		this.gaps.forEach((g, gi) => {
			const a = Date.parse(g.start);
			const b = Date.parse(g.end);
			spans.forEach((s, i) => {
				const ms = s.reduce((sum, [x, y]) => sum + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0);
				if (ms > 0) items[i].stalls.push([gi, ms]);
			});
		});
		for (const it of items) it.mainCost = Math.round(it.mainCost * 1e6) / 1e6;
		return {
			items,
			gaps: this.gaps,
			launches: this.launches,
			childEvents: this.childEvents,
			pairs: this.pairs,
			wraps: this.wraps,
			idleSince: this.idleFrom,
			lastActivity: this.last,
			unattributed: Math.round(unattributed * 1e6) / 1e6,
		};
	}

	/** Items along each branch's chain of snapshots, the branch holding the file's last snapshot first. */
	private items(session: string, nested: boolean): ItemRaw[] {
		const n = this.snaps.length;
		if (!n) return [];
		const hasChild = new Array<boolean>(n).fill(false);
		for (const s of this.snaps) if (s.pred >= 0) hasChild[s.pred] = true;
		const leaves = [...Array(n).keys()].filter((i) => !hasChild[i]).sort((a, b) => b - a);
		const main = new Set<number>();
		for (let i = leaves[0]; i >= 0; i = this.snaps[i].pred) main.add(i);
		const done = new Map<string, ItemRaw>();
		const order: ItemRaw[] = [];
		const reuse = new Map<number, number>();
		for (const leaf of leaves) {
			const chain: number[] = [];
			for (let i = leaf; i >= 0; i = this.snaps[i].pred) chain.unshift(i);
			const live = new Map<number, { identity: string; item?: ItemRaw }>();
			const leafTs = this.snaps[leaf].ts;
			for (const si of chain) {
				const snap = this.snaps[si];
				const seen = new Set<number>();
				for (const task of snap.tasks) {
					seen.add(task.id);
					let cur = live.get(task.id);
					if (!cur) {
						const identity = `${si}:${task.id}`;
						const known = done.get(identity);
						cur = { identity, item: known ? undefined : this.newItem(session, nested, task, snap, si, main, reuse) };
						live.set(task.id, cur);
						if (cur.item) {
							done.set(identity, cur.item);
							order.push(cur.item);
						}
					}
					if (cur.item) this.step(cur.item, task, snap.ts);
				}
				for (const [id, cur] of live) {
					if (seen.has(id)) continue;
					// Removed from the list (a clear, or a handover that drops it) while not finished: it was dropped here.
					if (cur.item && (cur.item.status === "pending" || cur.item.status === "in_progress")) this.step(cur.item, { ...lastLite(cur.item), status: "deleted" }, snap.ts);
					live.delete(id);
				}
			}
			const sideEnd = main.has(leaf) ? null : leafTs;
			for (const cur of live.values()) if (cur.item && sideEnd) for (const span of cur.item.active) if (span[1] === null) span[1] = sideEnd;
		}
		return order;
	}

	private newItem(session: string, nested: boolean, task: TaskLite, snap: Snapshot, si: number, main: Set<number>, reuse: Map<number, number>): ItemRaw {
		let key: string;
		if (task.uid) key = task.uid;
		else if (task.origin) key = `${task.origin}#${task.id}`;
		else if (main.has(si)) {
			const count = (reuse.get(task.id) ?? 0) + 1;
			reuse.set(task.id, count);
			key = count === 1 ? `${session}#${task.id}` : `${session}#${task.id}.${count}`;
		} else key = `${session}#${task.id}@${safeName(snap.entry).slice(0, 8)}`;
		return {
			key,
			id: task.id,
			title: task.title,
			owner: task.owner,
			uid: task.uid,
			origin: task.origin,
			level: nested ? "nested" : "top",
			status: "pending",
			created: snap.ts,
			active: [],
			evidence: 0,
			shas: [],
			refs: [],
			blockedBy: 0,
			mainCost: 0,
			stalls: [],
		};
	}

	private step(item: ItemRaw, task: TaskLite, ts: string) {
		const was = item.status;
		if (task.uid && item.uid !== task.uid) item.key = item.uid = task.uid;
		Object.assign(item, { title: task.title || item.title, owner: task.owner ?? item.owner, evidence: task.evidence, shas: task.shas, refs: task.refs, blockedBy: task.blockedBy });
		if (task.status === was) return;
		item.status = task.status;
		if (task.status === "in_progress" && was !== "in_progress") {
			item.start ??= ts;
			item.close = undefined;
			item.active.push([ts, null]);
		} else if (task.status !== "in_progress" && was === "in_progress") {
			const open = item.active.at(-1);
			if (open && open[1] === null) open[1] = ts;
		}
		if (task.status === "completed" || task.status === "deleted") item.close = ts;
		else if (task.status === "pending") item.close = undefined;
	}
}

function lastLite(item: ItemRaw): TaskLite {
	return { id: item.id, status: item.status, title: item.title, owner: item.owner, uid: item.uid, origin: item.origin, evidence: item.evidence, shas: item.shas, refs: item.refs, blockedBy: item.blockedBy };
}
