/**
 * A session's structural trace, the events the detectors read, in file order, for error analysis (`session-shape`).
 * It names tools, edit paths (safe names only), check runs by exit code, todo statuses and evidence results, close-guard
 * notice kinds and the sb role; message text, commands and arguments are read only to classify and never printed.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { anchorLine, ERA_START, isCheckRun, namesCheck, noticeKind, ProcessTracker } from "./detectors.ts";
import { graphOfTodo, sbKindOf } from "./plan-graph.ts";
import { safeName } from "./schema.ts";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const text = (content: unknown) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => (obj(p).type === "text" ? String(obj(p).text ?? "") : "")).join("\n") : "");

function counts(list: string[]): string {
	const by = new Map<string, number>();
	for (const k of list) by.set(k, (by.get(k) ?? 0) + 1);
	return [...by].map(([k, n]) => `${n} ${k}`).join(", ");
}

/** Lines of the trace, then one line per detector result. */
export async function sessionShape(file: string): Promise<string[]> {
	const out: string[] = [];
	const tracker = new ProcessTracker();
	const calls = new Map<string, { name: string; path?: string; check?: boolean; evidence?: string; action?: string; role?: string }>();
	let start = "";
	let seq = 0;
	let firstUser = true;
	let lastTodo = "";
	const at = (ts: unknown) => {
		const t = Date.parse(str(ts) ?? "");
		if (!start || !Number.isFinite(t)) return "";
		const s = Math.max(0, Math.round((t - Date.parse(start)) / 1000));
		return ` +${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
	};
	const push = (entry: Obj, what: string) => out.push(`#${seq}${at(entry.timestamp)} ${what}`);
	const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Number.POSITIVE_INFINITY });
	for await (const line of lines) {
		if (!line || line.charCodeAt(0) !== 123) continue;
		let entry: Obj;
		try {
			entry = JSON.parse(line) as Obj;
		} catch {
			continue;
		}
		seq += 1;
		tracker.feed(entry);
		const type = entry.type;
		if (type === "session") {
			start = str(entry.timestamp) ?? "";
			continue;
		}
		if (!start && str(entry.timestamp)) start = str(entry.timestamp)!;
		if (type === "compaction") push(entry, "compaction");
		else if (type === "custom") {
			const data = obj(entry.data);
			if (entry.customType === "todo/v1" && Array.isArray(data.tasks)) {
				const tasks = data.tasks.map(obj);
				const ev = tasks.flatMap((t) => (Array.isArray(t.evidence) ? t.evidence.map((e) => `evidence ${obj(e).result === "pass" ? "pass" : "fail"}`) : []));
				const graph = tasks.some((t) => graphOfTodo(t)) ? "; graph named" : "";
				const now = `todo list: ${counts(tasks.map((t) => safeName(t.status)))}${ev.length ? `; ${counts(ev)}` : ""}${graph}`;
				if (now !== lastTodo) push(entry, now);
				lastTodo = now;
			} else if (entry.customType === "straw-boss" && typeof data.duty === "string") push(entry, `sb kind ${safeName(data.duty)} (kind entry)`);
		} else if (type === "custom_message") {
			const details = obj(entry.details);
			if (entry.customType === "anchorloop-close-guard") push(entry, `close-guard ${noticeKind(entry.content)}`);
			else if (entry.customType === "pi-loop-monitor") {
				const o = obj(details.monitorOutcome);
				if (details.deliveryGroup === "monitor-terminal") push(entry, `monitor ${safeName(str(o.monitorId) ?? "?")} ended ${typeof o.exitCode === "number" ? `exit=${o.exitCode}` : safeName(o.status)}`);
			} else if (entry.customType === "straw-boss" && details.briefed) {
				const b = obj(details.briefed);
				push(entry, `sb role ${safeName(b.name ?? b.role)} ${b.duty ? safeName(b.duty) : ""}`.trim());
			} else if (entry.customType === "subagent_result") push(entry, "subagent result");
		} else if (type === "message") {
			const message = obj(entry.message);
			if (message.role === "system") {
				const section = obj(message.sections)["straw-boss"];
				if (typeof section === "string") push(entry, `sb kind ${sbKindOf(section) ?? "none (not a main)"} (role prompt)`);
			} else if (message.role === "user") {
				const words = text(message.content);
				push(entry, firstUser ? `user brief${namesCheck(words) ? " (names a check)" : ""}` : "user");
				firstUser = false;
			} else if (message.role === "assistant" && Array.isArray(message.content)) {
				for (const raw of message.content) {
					const part = obj(raw);
					if (part.type === "text" && typeof part.text === "string" && anchorLine(part.text) !== undefined) push(entry, "anchor stated");
					if (part.type !== "toolCall" || typeof part.id !== "string") continue;
					const args = obj(part.arguments);
					const name = safeName(part.name);
					const command = str(args.command);
					const items = [args, ...(Array.isArray(args.tasks) ? args.tasks.map(obj) : [])];
					const evidence = items.flatMap((i) => (Array.isArray(i.evidence) ? i.evidence.map((e) => (obj(e).result === "pass" ? "pass" : "fail")) : []));
					calls.set(part.id, {
						name,
						path: str(args.path),
						check: command !== undefined && isCheckRun(command),
						evidence: evidence.length ? counts(evidence.map((e) => `evidence ${e}`)) : undefined,
						action: str(args.action) ? safeName(args.action) : undefined,
						role: name === "subagent" ? safeName(str(args.agent) ?? "default") : undefined,
					});
					if (name === "todo" && items.some((i) => (typeof i.anchor === "string" && i.anchor.trim()) || obj(i.metadata).anchor)) push(entry, "todo anchor set");
				}
			} else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
				const call = calls.get(message.toolCallId);
				if (!call) continue;
				calls.delete(message.toolCallId);
				const code = obj(message.structuredContent).exit_code;
				const ok = typeof code === "number" ? code === 0 : message.isError !== true;
				const status = typeof code === "number" ? `exit=${code}` : ok ? "ok" : "error";
				if (call.name === "edit" || call.name === "write") push(entry, `${call.name} ${call.path ? safeName(call.path) : "?"} ${ok ? "ok" : "error"}`);
				else if (call.name === "bash" || call.name === "MonitorCreate") push(entry, `${call.name === "bash" ? "bash" : "monitor start"}${call.check ? " check" : ""} ${status}`);
				else if (call.name === "todo") push(entry, `todo ${call.action ?? "?"} ${ok ? "ok" : "error"}${call.evidence ? `; ${call.evidence}` : ""}`);
				else if (call.name === "subagent") push(entry, `subagent ${call.role} ${ok ? "launched" : "error"}`);
				else push(entry, `${call.name} ${ok ? "ok" : "error"}`);
			}
		}
	}
	for (const r of tracker.results(start >= ERA_START)) out.push(`${r.name}: ${r.label} (${r.explanation})`);
	return out;
}
