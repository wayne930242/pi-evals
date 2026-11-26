/**
 * Reads one pi session file (JSONL v3) line by line and derives records and a summary.
 * Only names, counts, durations, exit codes, outcomes, token and cost numbers leave this module; arguments,
 * results and text are looked at (to recognise a skill path, an Anchor line, a monitor id) and dropped.
 */
import { basename } from "node:path";
import { bucketOf, bump, type DayAgg, emptyDay, type SessionSummary } from "../aggregate.ts";
import { ERA_START, ProcessTracker } from "../detectors.ts";
import { dayOf } from "../paths.ts";
import { projectKey } from "../project.ts";
import { type Attrs, type EvalRecord, NAMES, record, safeName, type SkillTrigger, spanId, traceId } from "../schema.ts";
import { skillFromPath, skillsFromBlocks, skillsFromCatalog, skillsFromCommand } from "../skills.ts";
import { WorkTracker } from "../work/track.ts";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CHILD_FILE = new RegExp(`_(${UUID})-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{4}\\.jsonl$`);
const BRIEF_PARENT = new RegExp(`/artifacts/(${UUID})/context/`);
/** The subagent name in a brief path `…/context/<name>-<YYYY-MM-DDTHH-MM-SS>.md`. */
const BRIEF_NAME = new RegExp(`/artifacts/${UUID}/context/([A-Za-z0-9_.-]+?)-\\d{4}-\\d{2}-\\d{2}T[0-9-]+\\.md`);
/** Question tools: the main waits on a person while one runs. */
const HUMAN_WAIT = new Set(["ask_user_question", "ask_user", "secret_drop"]);
const ASK_TOOLS = new Set(["ask_user_question", "ask_user"]);

interface PendingCall {
	name: string;
	ts: string;
	trace?: string;
	skill?: { skill: string; resource?: string };
	monitor?: boolean;
	role?: string;
	model?: string;
	questions?: number;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** A subagent's logical id, from a file name `<ts>_<logicalId>-<gen8>-<gen8>-<gen4>.jsonl`. */
export const logicalIdOf = (path: string) => basename(path).match(CHILD_FILE)?.[1];

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((p) => (p && typeof p === "object" && (p as Obj).type === "text" ? String((p as Obj).text ?? "") : "")).join("\n");
}

export class SessionReader {
	readonly records: EvalRecord[] = [];
	private sessionId = "";
	private project = "unknown";
	private start = "";
	private end = "";
	private trace?: string;
	private traceUsage?: { rec: EvalRecord; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; tools: number };
	private calls = new Map<string, PendingCall>();
	private monitorStart = new Map<string, string>();
	private tracker = new ProcessTracker();
	private days: Record<string, DayAgg> = {};
	private spawned: SessionSummary["spawned"] = [];
	private loaded = new Set<string>();
	private parentId?: string;
	private catalog?: string[];
	private cost = 0;
	private tokens = 0;
	private toolCalls = 0;
	private notices: SessionSummary["notices"] = {};
	private firstUser = true;
	private model?: string;
	private childName?: string;
	private cwd?: string;
	private work = new WorkTracker();
	readonly logicalId?: string;
	private readonly home: string;
	private readonly emit: (r: EvalRecord) => void;

	/** `emit` receives each record as it is made; by default they collect in `records`. */
	constructor(path: string, home: string, emit?: (r: EvalRecord) => void) {
		this.logicalId = logicalIdOf(path);
		this.home = home;
		this.emit = emit ?? ((r) => void this.records.push(r));
	}

	private day(ts: string): DayAgg {
		const key = dayOf(ts || this.start || 0);
		return (this.days[key] ??= emptyDay());
	}

	private base(): Attrs {
		return { "session.id": this.sessionId, "pi.project": this.project };
	}

	feedLine(line: string): void {
		if (!line || line.charCodeAt(0) !== 123) return;
		let entry: Obj;
		try {
			entry = JSON.parse(line) as Obj;
		} catch {
			return;
		}
		this.feed(entry);
	}

	feed(entry: Obj): void {
		const ts = str(entry.timestamp) ?? this.end;
		if (ts && (!this.end || ts > this.end)) this.end = ts;
		const type = entry.type;
		if (type === "session") return this.header(entry);
		if (!this.start && ts) this.start = ts;
		const kind = this.tracker.feed(entry);
		this.work.entry(entry, ts);
		if (type === "model_change") {
			this.model = safeName(`${str(entry.provider) ?? "?"}/${str(entry.modelId) ?? "?"}`);
		} else if (type === "compaction") {
			this.day(ts).compactions += 1;
			this.emit(record({ name: NAMES.compaction, kind: "event", ts, source: "backfill", trace_id: this.trace, attrs: this.base() }));
		} else if (type === "custom_message") {
			this.customMessage(entry, ts, kind);
		} else if (type === "message") {
			const message = obj(entry.message);
			const role = message.role;
			if (role === "user") this.user(entry, message, ts);
			else if (role === "assistant") this.assistant(message, ts);
			else if (role === "toolResult") this.toolResult(message, ts);
			else if (role === "system") this.system(message);
		}
	}

	private header(entry: Obj) {
		this.sessionId = safeName(str(entry.id) ?? "");
		this.start = str(entry.timestamp) ?? this.start;
		this.project = safeName(projectKey(str(entry.cwd), this.home));
		const cwd = str(entry.cwd);
		if (cwd && safeName(cwd) === cwd) this.cwd = cwd;
	}

	private system(message: Obj) {
		const sections = obj(message.sections);
		const names = skillsFromCatalog(sections.skills ?? textOf(message.content));
		if (names.length) this.catalog = names.map(safeName);
	}

	private user(entry: Obj, message: Obj, ts: string) {
		const text = textOf(message.content);
		if (this.firstUser) {
			this.firstUser = false;
			const head = text.slice(0, 2000);
			const parent = head.match(BRIEF_PARENT)?.[1];
			if (parent && this.logicalId) this.parentId = parent;
			const name = head.match(BRIEF_NAME)?.[1];
			if (name && this.logicalId) this.childName = safeName(name);
		}
		const anchor = str(entry.id) ?? ts;
		this.closeTrace();
		this.trace = traceId(this.sessionId, anchor);
		const slash = text.startsWith("<skill name=") ? skillsFromBlocks(text.slice(0, 4000)) : [];
		const rec = record({
			name: NAMES.prompt,
			kind: "span",
			ts,
			source: "backfill",
			trace_id: this.trace,
			span_id: spanId(this.sessionId, anchor),
			attrs: { ...this.base(), "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "pi", "pi.prompt.origin": slash.length ? "skill_command" : "user" },
		});
		this.traceUsage = { rec, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, tools: 0 };
		this.day(ts).prompts += 1;
		for (const skill of slash) this.skillLoad(skill, "slash", ts);
	}

	private closeTrace() {
		const t = this.traceUsage;
		if (!t) return;
		Object.assign(t.rec.attrs, {
			"gen_ai.usage.input_tokens": t.input,
			"gen_ai.usage.output_tokens": t.output,
			"gen_ai.usage.cache_read.input_tokens": t.cacheRead,
			"gen_ai.usage.cache_write.input_tokens": t.cacheWrite,
			"pi.usage.cost_usd": Math.round(t.cost * 1e6) / 1e6,
			"pi.tool_calls": t.tools,
		});
		if (this.end > t.rec.ts) {
			t.rec.end_ts = this.end;
			t.rec.duration_ms = Date.parse(this.end) - Date.parse(t.rec.ts);
		}
		this.emit(t.rec);
		this.traceUsage = undefined;
	}

	private assistant(message: Obj, ts: string) {
		const model = safeName(`${str(message.provider) ?? "?"}/${str(message.model) ?? "?"}`);
		this.model = model;
		const usage = obj(message.usage);
		const day = this.day(ts);
		const u = { input: num(usage.input), output: num(usage.output), cacheRead: num(usage.cacheRead), cacheWrite: num(usage.cacheWrite), cost: num(obj(usage.cost).total) };
		day.usage.input += u.input;
		day.usage.output += u.output;
		day.usage.cacheRead += u.cacheRead;
		day.usage.cacheWrite += u.cacheWrite;
		day.usage.cost += u.cost;
		day.usage.calls += 1;
		bump(day.models, model);
		this.cost += u.cost;
		this.work.assistant(ts, u.cost, message.stopReason);
		this.tokens += num(usage.totalTokens) || u.input + u.output + u.cacheRead + u.cacheWrite;
		if (this.traceUsage) {
			this.traceUsage.input += u.input;
			this.traceUsage.output += u.output;
			this.traceUsage.cacheRead += u.cacheRead;
			this.traceUsage.cacheWrite += u.cacheWrite;
			this.traceUsage.cost += u.cost;
		}
		if (!Array.isArray(message.content)) return;
		for (const raw of message.content) {
			const part = obj(raw);
			if (part.type !== "toolCall" || typeof part.id !== "string") continue;
			const name = safeName(str(part.name) ?? "unknown");
			const args = obj(part.arguments);
			const call: PendingCall = { name, ts, trace: this.trace };
			if (name === "read") call.skill = skillFromPath(args.path ?? args.file_path);
			else if (name === "bash") for (const skill of skillsFromCommand(args.command)) this.skillLoad(skill, "bash", ts, part.id);
			else if (name === "subagent") {
				call.role = safeName(str(args.agent) ?? "default");
				call.model = safeName(str(args.model) ?? "default");
			} else if (ASK_TOOLS.has(name)) call.questions = Array.isArray(args.questions) ? args.questions.length : 1;
			else if (name === "MonitorCreate") call.monitor = true;
			this.calls.set(part.id, call);
		}
	}

	private toolResult(message: Obj, ts: string) {
		const id = str(message.toolCallId);
		const call = id ? this.calls.get(id) : undefined;
		const name = call?.name ?? safeName(str(message.toolName) ?? "unknown");
		if (id) this.calls.delete(id);
		const isError = message.isError === true;
		const measured = typeof message.durationMs === "number";
		const duration = measured ? num(message.durationMs) : call ? Math.max(0, Date.parse(ts) - Date.parse(call.ts)) : undefined;
		const details = obj(message.details);
		const exit = obj(message.structuredContent).exit_code;
		const day = this.day(ts);
		const agg = (day.tools[name] ??= { calls: 0, errors: 0, durSum: 0, durN: 0 });
		agg.calls += 1;
		if (isError) agg.errors += 1;
		if (duration !== undefined) {
			agg.durSum += duration;
			agg.durN += 1;
		}
		this.toolCalls += 1;
		if (this.traceUsage) this.traceUsage.tools += 1;
		const attrs: Attrs = {
			...this.base(),
			"gen_ai.operation.name": "execute_tool",
			"gen_ai.tool.name": name,
			"gen_ai.tool.call.id": id,
			"error.type": isError ? "tool_error" : undefined,
			"pi.duration.source": measured ? "measured" : "timestamps",
			"pi.tool.exit_code": typeof exit === "number" ? exit : undefined,
		};
		if (call?.skill && !isError) {
			attrs["gen_ai.skill.name"] = call.skill.skill; // record() checks it; skillLoad keys the summary by safeName
			if (call.skill.resource) attrs["gen_ai.skill.resource.name"] = call.skill.resource;
			else this.skillLoad(call.skill.skill, "read", ts, id);
		}
		if (ASK_TOOLS.has(name)) this.ask(attrs, details, isError, duration, call, day);
		if (name === "subagent" && !isError) {
			const child = str(details.id) ? safeName(details.id) : undefined;
			const role = safeName(str(details.agent) ?? call?.role ?? "default");
			const model = safeName(str(details.model) ?? call?.model ?? "default");
			attrs["gen_ai.agent.name"] = role;
			attrs["gen_ai.request.model"] = model;
			attrs["pi.subagent.logical_id"] = child;
			bump(day.subagents, `${role}|${model}`);
			if (child) {
				const name = str(details.name) ? safeName(details.name) : undefined;
				const item = str(details.item) ? safeName(details.item) : undefined;
				this.spawned.push({ id: child, role, model, name });
				this.work.launch({ id: child, name, role, model, item, at: ts });
			}
		}
		if (!isError && call && HUMAN_WAIT.has(name)) this.work.wait(call.ts, ts, "human");
		if (!isError && name === "subagent_resume" && str(details.name)) this.work.child(ts, String(details.name), "resume");
		if (!isError && name === "boss_pair" && str(details.thread)) {
			const opt = (v: unknown) => (str(v) ? safeName(v) : undefined);
			this.work.pair({ thread: safeName(details.thread), worker: opt(details.worker), reviewer: opt(details.reviewer), item: opt(details.item), at: ts });
		}
		if (!isError && name === "boss_wrap") this.work.wrap(ts, details.wrapped === true);
		if (call?.monitor && !isError) {
			const monitorId = textOf(message.content).concat(" ", str(details.summary) ?? "").match(/Monitor #(\d+)/)?.[1];
			day.monitors.started += 1;
			if (monitorId) this.monitorStart.set(monitorId, ts);
		}
		this.emit(
			record({
				name: NAMES.tool,
				kind: "span",
				ts: call?.ts ?? ts,
				end_ts: ts,
				duration_ms: duration,
				source: "backfill",
				trace_id: call?.trace ?? this.trace,
				span_id: id ? spanId(this.sessionId, id) : undefined,
				attrs,
			}),
		);
	}

	private ask(attrs: Attrs, details: Obj, isError: boolean, duration: number | undefined, call: PendingCall | undefined, day: DayAgg) {
		const cancelled = details.cancelled === true;
		const questions = Array.isArray(details.questions) ? details.questions.length : Array.isArray(details.answers) ? details.answers.length : (call?.questions ?? 1);
		attrs["pi.ask_user.questions"] = questions;
		attrs["pi.ask_user.cancelled"] = cancelled;
		attrs["pi.ask_user.source"] = "unknown";
		day.ask.calls += 1;
		if (cancelled) day.ask.cancelled += 1;
		if (isError) day.ask.errors += 1;
		bump(day.ask.sources, "unknown");
		if (duration !== undefined && !isError) {
			day.ask.durSum += duration;
			day.ask.durN += 1;
			day.ask.buckets[bucketOf(duration)] += 1;
		}
	}

	private customMessage(entry: Obj, ts: string, kind: string | undefined) {
		const type = entry.customType;
		if (type === "pi-herdr-agents:declared-skills") {
			for (const skill of skillsFromBlocks(textOf(entry.content))) this.skillLoad(skill, "declared", ts);
		} else if (type === "subagent_result" && str(obj(entry.details).name)) {
			this.work.child(ts, String(obj(entry.details).name), "result");
		} else if (kind) {
			bump(this.notices as Record<string, number>, kind);
			bump(this.day(ts).notices, kind);
			this.emit(record({ name: NAMES.notice, kind: "event", ts, source: "backfill", trace_id: this.trace, attrs: { ...this.base(), "anchorloop.notice.kind": kind } }));
		} else if (type === "pi-loop-monitor") {
			const details = obj(entry.details);
			if (details.deliveryGroup !== "monitor-terminal") return;
			const outcome = obj(details.monitorOutcome);
			const monitorId = str(outcome.monitorId) ?? str(details.monitorId);
			const started = monitorId ? this.monitorStart.get(monitorId) : undefined;
			const duration = started ? Date.parse(ts) - Date.parse(started) : undefined;
			if (monitorId) this.monitorStart.delete(monitorId);
			const status = safeName(str(outcome.status) ?? "unknown");
			const day = this.day(ts);
			day.monitors.finished += 1;
			bump(day.monitors.statuses, status);
			if (duration !== undefined) {
				day.monitors.durSum += duration;
				day.monitors.durN += 1;
			}
			this.emit(
				record({
					name: NAMES.monitor,
					kind: "span",
					ts: started ?? ts,
					end_ts: ts,
					duration_ms: duration,
					source: "backfill",
					trace_id: this.trace,
					attrs: { ...this.base(), "pi.monitor.id": monitorId, "pi.monitor.status": status, "pi.monitor.exit_code": typeof outcome.exitCode === "number" ? outcome.exitCode : undefined, "pi.monitor.output_lines": num(outcome.outputLines) },
				}),
			);
		}
	}

	private skillLoad(raw: string, trigger: SkillTrigger, ts: string, callId?: string) {
		const skill = safeName(raw);
		const day = this.day(ts);
		bump(day.skills, skill);
		bump(day.skillTriggers, trigger);
		this.loaded.add(skill);
		this.emit(
			record({
				name: NAMES.skill,
				kind: "event",
				ts,
				source: "backfill",
				trace_id: this.trace,
				attrs: { ...this.base(), "gen_ai.skill.name": skill, "pi.skill.trigger": trigger, "gen_ai.tool.call.id": callId },
			}),
		);
	}

	/** Ends the session: closes the open trace, runs the detectors, and returns the summary and offered skills. */
	finish(): { summary: SessionSummary; catalog?: string[] } {
		this.closeTrace();
		const startDay = this.day(this.start);
		startDay.sessions += 1;
		if (this.logicalId) startDay.subagentSessions += 1;
		for (const skill of this.loaded) {
			bump(startDay.skillSessions, skill);
			bump(startDay.skillCost, skill, this.cost);
		}
		const inScope = (this.start || "") >= ERA_START;
		const evals: SessionSummary["evals"] = {};
		for (const result of this.tracker.results(inScope)) {
			evals[result.name] = { label: result.label, value: result.value, explanation: result.explanation };
			if (result.explanation !== "out_of_scope_pre_3.0") {
				const t = (startDay.detectors[result.name] ??= { pass: 0, fail: 0, na: 0 });
				t[result.label] += 1;
			}
			this.emit(
				record({
					name: NAMES.evaluation,
					kind: "event",
					ts: this.end || this.start,
					source: "backfill",
					attrs: {
						...this.base(),
						"gen_ai.evaluation.name": result.name,
						"gen_ai.evaluation.score.label": result.label,
						"gen_ai.evaluation.score.value": result.value ?? (result.label === "pass" ? 1 : result.label === "fail" ? 0 : undefined),
						"gen_ai.evaluation.explanation": result.explanation,
						"eval.annotator_kind": "CODE",
						"eval.scope": "session",
						"eval.detector.version": 1,
					},
				}),
			);
		}
		this.emit(
			record({
				name: NAMES.session,
				kind: "event",
				ts: this.start,
				end_ts: this.end,
				source: "backfill",
				attrs: {
					...this.base(),
					"pi.session.kind": this.logicalId ? "subagent" : "interactive",
					"pi.subagent.logical_id": this.logicalId,
					"pi.session.parent_id": this.parentId,
					"gen_ai.request.model": this.model,
					"pi.tool_calls": this.toolCalls,
					"pi.usage.cost_usd": Math.round(this.cost * 1e6) / 1e6,
				},
			}),
		);
		const summary: SessionSummary = {
			v: 1,
			sessionId: this.sessionId,
			project: this.project,
			start: this.start,
			end: this.end,
			kind: this.logicalId ? "subagent" : "interactive",
			logicalId: this.logicalId,
			parentId: this.parentId,
			model: this.model,
			childName: this.childName,
			cwd: this.cwd,
			spawned: this.spawned,
			cost: this.cost,
			tokens: this.tokens,
			toolCalls: this.toolCalls,
			evals,
			notices: this.notices,
			days: this.days,
		};
		const work = this.work.finish(this.sessionId, !!this.logicalId);
		if (work) summary.work = work;
		return { summary, catalog: this.catalog };
	}
}
