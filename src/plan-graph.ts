/**
 * `plan_names_graph`: whether a Straw Boss main of kind coordinator or standing names its plan's graph when it plans.
 *
 * The graph is a todo's own `graph` (pi-todo-ledger 0.4.0: `single-loop`, `fan-out/fan-in`, `orchestrator-worker`), else a
 * legacy `metadata.graph`, read as pi-straw-boss reads it (`items.ts` `todosOf`, `duty.ts` `graphOf`, MIT, Copyright (c) 2026
 * Wei Hung, sb 0.103.0). From sb 0.101.0 a main whose `todo` create leaves open todos with no graph gets planning.md §1-§2
 * on that result (`planhint.ts`); the next todo call shows whether the main took it. A train's steps (`metadata.sb`) are not
 * the plan. The main's kind comes from its role prompt (system section or a role steer) and its kind entries.
 */
import type { DetectorResult } from "./detectors.ts";

/** The planning-rule block's first line (sb `planhint.ts` OPENING). */
const RULE_OPENING = "sb: your open todos name no graph.";
const GRAPHS = new Set(["single-loop", "fan-out/fan-in", "orchestrator-worker"]);
const JUDGED = new Set(["coordinator", "standing"]);
const MAIN_PROMPT = /You are the main agent of Herdr tab .*?,? of kind ([a-z]+)/;
const STANDING_PROMPT = /You are the standing main of Herdr tab /;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});

/** A legacy `metadata.graph` as mains wrote it, normalised like sb's `graphOf`. */
export function legacyGraph(v: unknown): string | undefined {
	if (v === "orchestrator-worker") return v;
	if (v === "fan-out/fan-in" || v === "fan-out") return "fan-out/fan-in";
	if (v === "single" || (typeof v === "string" && v.startsWith("single-loop"))) return "single-loop";
	return undefined;
}

/** A todo's graph: its own field when it is a graph name, else its legacy metadata. */
export function graphOfTodo(todo: unknown): string | undefined {
	const t = obj(todo);
	if (typeof t.graph === "string" && GRAPHS.has(t.graph)) return t.graph;
	return legacyGraph(obj(t.metadata).graph);
}

/** The plan's open todos: not completed or deleted, and not a train's step. */
function openOf(tasks: unknown[]): Obj[] {
	return tasks.map(obj).filter((t) => t.status !== "completed" && t.status !== "deleted" && !obj(t.metadata).sb);
}

function text(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.map((p) => (obj(p).type === "text" ? String(obj(p).text ?? "") : "")).join("\n") : "";
}

export class PlanGraphTracker {
	private kind: string | undefined;
	private wasMain = false;
	private tasks: unknown[] | undefined;
	private calls = new Map<string, boolean>();
	/** The first plan (a create leaving open todos) named no graph; `rule`: sb's block came with it. */
	private missed: { rule: boolean } | undefined;
	private result: DetectorResult | undefined;

	feed(entry: Obj): void {
		if (this.result) return;
		const type = entry.type;
		if (type === "custom") {
			const data = obj(entry.data);
			if (entry.customType === "todo/v1" && Array.isArray(data.tasks)) this.tasks = data.tasks;
			else if (entry.customType === "straw-boss" && typeof data.duty === "string" && this.kind) this.setKind(data.duty);
			return;
		}
		if (type === "custom_message" && entry.customType === "straw-boss") {
			const briefed = obj(obj(entry.details).briefed);
			const role = briefed.name ?? briefed.role;
			if (typeof role === "string") this.setKind(role === "main" && typeof briefed.duty === "string" ? briefed.duty : undefined);
			return;
		}
		if (type !== "message") return;
		const message = obj(entry.message);
		if (message.role === "system") {
			const section = obj(message.sections)["straw-boss"];
			if (typeof section !== "string") return;
			this.setKind(STANDING_PROMPT.test(section) ? "standing" : MAIN_PROMPT.exec(section)?.[1]);
		} else if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const raw of message.content) {
				const part = obj(raw);
				if (part.type === "toolCall" && part.name === "todo" && typeof part.id === "string") this.calls.set(part.id, obj(part.arguments).action === "create");
			}
		} else if (message.role === "toolResult" && typeof message.toolCallId === "string" && this.calls.has(message.toolCallId)) {
			const create = this.calls.get(message.toolCallId)!;
			this.calls.delete(message.toolCallId);
			if (message.isError === true || !this.kind || !JUDGED.has(this.kind)) return;
			const listed = obj(message.details).tasks;
			this.todoResult(create, Array.isArray(listed) ? listed : (this.tasks ?? []), text(message.content).includes(RULE_OPENING));
		}
	}

	private setKind(kind: string | undefined) {
		this.kind = kind;
		if (kind && JUDGED.has(kind)) this.wasMain = true;
	}

	private todoResult(create: boolean, tasks: unknown[], rule: boolean) {
		const name = "plan_names_graph";
		const open = openOf(tasks);
		const named = open.some((t) => graphOfTodo(t));
		if (!this.missed) {
			if (!create || !open.length) return;
			if (named) this.result = { name, label: "pass", explanation: "graph_at_first_create" };
			else this.missed = { rule };
			return;
		}
		this.result = named
			? { name, label: "pass", explanation: this.missed.rule ? "graph_after_rule" : "graph_next_todo_call" }
			: { name, label: "fail", explanation: "kept_planning_without_graph" };
	}

	results(): DetectorResult {
		const name = "plan_names_graph";
		if (this.result) return this.result;
		if (this.missed) return { name, label: "fail", explanation: "plan_without_graph" };
		return { name, label: "na", explanation: this.wasMain ? "no_plan" : "not_sb_main" };
	}
}
