/**
 * The live observer: what a session file does not keep. One tool-owner snapshot per session, a record per finished
 * tool call (blocked and aborted calls included), skill loads, monitor lifecycles from `pi.events`, and where an
 * ask-user answer came from. Records go to the state dir; the session file is never touched, and a failed write
 * never breaks a turn.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Layout } from "./paths.ts";
import { ownerOf } from "./owners.ts";
import { projectKey } from "./project.ts";
import { type Attrs, type EvalRecord, NAMES, record, safeName, type SkillTrigger, spanId, traceId } from "./schema.ts";
import { skillFromPath, skillsFromBlocks, skillsFromCommand } from "./skills.ts";
import { liveWriter } from "./store.ts";
import { logicalIdOf } from "./extract/session.ts";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const ASK_TOOLS = new Set(["ask_user_question", "ask_user"]);

interface Pending {
	start: number;
	skill?: { skill: string; resource?: string };
	questions?: number;
}

export interface ObserverOptions {
	layout: Layout;
	home: string;
	now?: () => number;
}

/** What the session has done so far that a label needs: the skills it loaded. */
export interface Observed {
	skills(): string[];
}

export function observe(pi: ExtensionAPI, options: ObserverOptions): Observed {
	const now = options.now ?? Date.now;
	let sessionId = "";
	let project = "unknown";
	let trace: string | undefined;
	let snapshotTaken = false;
	let owners = new Map<string, { owner: string; version?: string }>();
	let pending = new Map<string, Pending>();
	let remoteAnswers = new Set<string>();
	let monitorStarts = new Map<string, number>();
	let monitorsDone = new Set<string>();
	let unsubscribe: (() => void)[] = [];
	let write: (r: EvalRecord | EvalRecord[]) => void = () => {};
	let hasUI = false;
	let loaded = new Set<string>();

	const iso = (t: number) => new Date(t).toISOString();
	const base = (): Attrs => ({ "session.id": sessionId, "pi.project": project });
	const emit = (fields: Parameters<typeof record>[0]) => write(record(fields));

	const skillLoad = (skill: string, trigger: SkillTrigger, callId?: string) => {
		loaded.add(skill);
		emit({ name: NAMES.skill, kind: "event", ts: iso(now()), source: "live", trace_id: trace, attrs: { ...base(), "gen_ai.skill.name": skill, "pi.skill.trigger": trigger, "gen_ai.tool.call.id": callId } });
	};

	const snapshot = () => {
		if (snapshotTaken) return;
		snapshotTaken = true;
		try {
			owners = new Map(pi.getAllTools().map((tool) => [tool.name, ownerOf(tool)]));
		} catch {
			owners = new Map();
		}
		const tools = [...owners].map(([name, o]) => `${name}=${o.owner}${o.version ? `@${o.version}` : ""}`).sort();
		emit({ name: NAMES.tools, kind: "event", ts: iso(now()), source: "live", attrs: { ...base(), "pi.tools": tools } });
	};

	const ownerFor = (tool: string) => {
		if (!owners.has(tool)) {
			try {
				const found = pi.getAllTools().find((t) => t.name === tool);
				if (found) owners.set(tool, ownerOf(found));
			} catch {}
		}
		return owners.get(tool);
	};

	const monitorEnd = (data: unknown, fallback: string) => {
		const d = obj(data);
		const id = str(d.monitorId) ?? (typeof d.monitorId === "number" ? String(d.monitorId) : undefined);
		if (!id || monitorsDone.has(id)) return;
		monitorsDone.add(id);
		const started = monitorStarts.get(id);
		const end = now();
		const reported = obj(d.reportedOutcome);
		emit({
			name: NAMES.monitor,
			kind: "span",
			ts: iso(started ?? end),
			end_ts: iso(end),
			duration_ms: started !== undefined ? end - started : undefined,
			source: "live",
			trace_id: trace,
			attrs: {
				...base(),
				"pi.monitor.id": id,
				"pi.monitor.status": str(d.status) ?? fallback,
				"pi.monitor.exit_code": typeof d.exitCode === "number" ? d.exitCode : undefined,
				"pi.monitor.output_lines": typeof d.outputLines === "number" ? d.outputLines : undefined,
				"pi.monitor.reported_status": str(reported.status),
			},
		});
	};

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		for (const off of unsubscribe) off();
		sessionId = ctx.sessionManager.getSessionId();
		project = projectKey(ctx.cwd, options.home);
		hasUI = ctx.hasUI;
		trace = undefined;
		snapshotTaken = false;
		owners = new Map();
		pending = new Map();
		remoteAnswers = new Set();
		monitorStarts = new Map();
		monitorsDone = new Set();
		loaded = new Set();
		let file: string | undefined;
		try {
			file = ctx.sessionManager.getSessionFile?.();
		} catch {}
		const logicalId = file ? logicalIdOf(file) : undefined;
		write = liveWriter(options.layout.events, (message) => {
			try {
				if (ctx.hasUI) ctx.ui.notify(message, "warning");
				else console.error(message);
			} catch {}
		}, now);
		emit({
			name: NAMES.session,
			kind: "event",
			ts: iso(now()),
			source: "live",
			// The session file name marks a subagent; PI_SUBAGENT_ID is inherited by anything a subagent starts, so it is not used.
			attrs: { ...base(), "pi.session.kind": logicalId ? "subagent" : "interactive", "pi.subagent.logical_id": logicalId },
		});
		const on = (channel: string, handler: (data: unknown) => void) => {
			try {
				unsubscribe.push(pi.events.on(channel, handler));
			} catch {}
		};
		on("monitor:started", (data) => {
			const d = obj(data);
			const id = str(d.monitorId) ?? (typeof d.monitorId === "number" ? String(d.monitorId) : undefined);
			if (id) {
				monitorStarts.set(id, typeof d.timestamp === "number" ? d.timestamp : now());
				monitorsDone.delete(id);
			}
		});
		on("monitor:finished", (data) => monitorEnd(data, "finished"));
		on("monitor:done", (data) => monitorEnd(data, "completed"));
		on("monitor:error", (data) => monitorEnd(data, "error"));
		// A remote answer (e.g. from a phone) is reported by the answer channel's result; a rejected one is not the answer.
		on("rpiv:ask-user:answer-result", (data) => {
			const d = obj(data);
			const id = str(d.toolCallId);
			if (id && d.ok === true) remoteAnswers.add(id);
		});
	});

	pi.on("session_shutdown", () => {
		for (const off of unsubscribe) off();
		unsubscribe = [];
	});

	pi.on("before_agent_start", (event) => {
		snapshot();
		const skills = obj(event).systemPromptOptions ? obj(obj(event).systemPromptOptions).skills : undefined;
		if (Array.isArray(skills) && trace === undefined) {
			const names = skills.map((s) => str(obj(s).name)).filter((n): n is string => !!n);
			emit({ name: NAMES.skills, kind: "event", ts: iso(now()), source: "live", attrs: { ...base(), "pi.skills": names } });
		}
		const at = now();
		trace = traceId(sessionId, `live:${at}`);
		emit({
			name: NAMES.prompt,
			kind: "span",
			ts: iso(at),
			source: "live",
			trace_id: trace,
			span_id: spanId(sessionId, `live:${at}`),
			attrs: { ...base(), "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "pi", "pi.prompt.origin": obj(event).messageType === "custom" ? "extension" : "user" },
		});
	});

	pi.on("input", (event) => {
		const text = str(obj(event).text);
		if (text?.startsWith("/skill:")) {
			const name = text.slice(7).split(/\s/)[0];
			if (name) skillLoad(name, "slash");
		}
	});

	pi.on("message_end", (event) => {
		const message = obj(obj(event).message);
		if (message.customType === "pi-herdr-agents:declared-skills") {
			const content = message.content;
			const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => str(obj(p).text) ?? "").join("\n") : "";
			for (const skill of skillsFromBlocks(text)) skillLoad(skill, "declared");
		}
	});

	pi.on("tool_execution_start", (event) => {
		const args = obj(event.args);
		const entry: Pending = { start: now() };
		if (event.toolName === "read") entry.skill = skillFromPath(args.path ?? args.file_path);
		else if (event.toolName === "bash") for (const skill of skillsFromCommand(args.command)) skillLoad(skill, "bash", event.toolCallId);
		else if (ASK_TOOLS.has(event.toolName)) entry.questions = Array.isArray(args.questions) ? args.questions.length : 1;
		pending.set(event.toolCallId, entry);
	});

	pi.on("tool_execution_end", (event) => {
		const started = pending.get(event.toolCallId);
		pending.delete(event.toolCallId);
		const end = now();
		const owner = ownerFor(event.toolName);
		const details = obj(obj(event.result).details);
		const attrs: Attrs = {
			...base(),
			"gen_ai.operation.name": "execute_tool",
			"gen_ai.tool.name": event.toolName,
			"gen_ai.tool.call.id": event.toolCallId,
			"error.type": event.isError ? "tool_error" : undefined,
			"pi.tool.owner": owner?.owner,
			"pi.tool.owner_version": owner?.version,
			"pi.tool.parent_call": typeof obj(event).parentToolCallId === "string" ? true : undefined,
			"pi.duration.source": typeof event.durationMs === "number" ? "measured" : "not_run",
		};
		if (started?.skill && !event.isError) {
			attrs["gen_ai.skill.name"] = started.skill.skill;
			if (started.skill.resource) attrs["gen_ai.skill.resource.name"] = started.skill.resource;
			else skillLoad(started.skill.skill, "read", event.toolCallId);
		}
		if (ASK_TOOLS.has(event.toolName)) {
			attrs["pi.ask_user.questions"] = Array.isArray(details.questions) ? details.questions.length : (started?.questions ?? 1);
			attrs["pi.ask_user.cancelled"] = details.cancelled === true;
			attrs["pi.ask_user.source"] = remoteAnswers.has(event.toolCallId) ? "remote" : hasUI ? "terminal" : "none";
			remoteAnswers.delete(event.toolCallId);
		}
		if (event.toolName === "subagent" && !event.isError) {
			attrs["gen_ai.agent.name"] = str(details.agent) ?? "default";
			attrs["gen_ai.request.model"] = str(details.model) ?? "default";
			attrs["pi.subagent.logical_id"] = str(details.id);
		}
		emit({
			name: NAMES.tool,
			kind: "span",
			ts: iso(started?.start ?? end),
			end_ts: iso(end),
			duration_ms: typeof event.durationMs === "number" ? event.durationMs : undefined,
			source: "live",
			trace_id: trace,
			span_id: spanId(sessionId, event.toolCallId),
			attrs,
		});
	});
	return { skills: () => [...new Set([...loaded].map((name) => safeName(name)))].filter((n) => n !== "redacted").sort() };
}
