/**
 * The one record shape (docs/schema.md): one JSON object per line, OpenTelemetry GenAI names where they exist,
 * `pi.*` for pi facts, `anchorloop.*` for process facts, `eval.*` for evaluation metadata.
 *
 * Privacy is enforced here: every string attribute must look like a name (no spaces, no newlines, bounded length).
 * Anything else is replaced by "redacted", so free text from a transcript cannot reach a record by accident.
 */
import { createHash } from "node:crypto";

export const SCHEMA_VERSION = 1;

export type Source = "backfill" | "live";
export type AttrValue = string | number | boolean | string[];
export type Attrs = Record<string, AttrValue | undefined>;

export interface EvalRecord {
	schema_version: number;
	/** OTel span or event name, e.g. `execute_tool`, `invoke_agent`, `gen_ai.evaluation.result`. */
	name: string;
	kind: "span" | "event";
	/** Start (span) or occurrence (event), ISO 8601 UTC. */
	ts: string;
	end_ts?: string;
	duration_ms?: number;
	/** One trace per user prompt. */
	trace_id?: string;
	span_id?: string;
	source: Source;
	attrs: Record<string, AttrValue>;
}

const NAME = /^[\p{L}\p{N}_@./:+#=|-]{0,160}$/u;

/** A string attribute that passes the name check, else "redacted". */
export function safeName(value: unknown): string {
	if (typeof value !== "string") return "unknown";
	return NAME.test(value) ? value : "redacted";
}

function clean(attrs: Attrs): Record<string, AttrValue> {
	const out: Record<string, AttrValue> = {};
	for (const [key, value] of Object.entries(attrs)) {
		if (value === undefined) continue;
		if (typeof value === "string") out[key] = safeName(value);
		else if (Array.isArray(value)) out[key] = value.slice(0, 200).map(safeName);
		else if (typeof value === "number") {
			if (Number.isFinite(value)) out[key] = value;
		} else out[key] = value;
	}
	return out;
}

export function record(fields: Omit<EvalRecord, "schema_version" | "attrs"> & { attrs: Attrs }): EvalRecord {
	const out: EvalRecord = { schema_version: SCHEMA_VERSION, name: safeName(fields.name), kind: fields.kind, ts: fields.ts, source: fields.source, attrs: clean(fields.attrs) };
	if (fields.end_ts) out.end_ts = fields.end_ts;
	if (typeof fields.duration_ms === "number" && Number.isFinite(fields.duration_ms)) out.duration_ms = Math.max(0, Math.round(fields.duration_ms));
	if (fields.trace_id) out.trace_id = fields.trace_id;
	if (fields.span_id) out.span_id = fields.span_id;
	return out;
}

const hex = (text: string, length: number) => createHash("sha1").update(text).digest("hex").slice(0, length);
/** 32-hex trace id, stable for a session and the entry that opened the prompt. */
export const traceId = (sessionId: string, anchor: string) => hex(`trace:${sessionId}:${anchor}`, 32);
/** 16-hex span id, stable across re-extraction. */
export const spanId = (sessionId: string, anchor: string) => hex(`span:${sessionId}:${anchor}`, 16);
export const fileKey = (path: string) => hex(`file:${path}`, 20);

/** Record names this package writes. */
export const NAMES = {
	session: "pi.session",
	prompt: "invoke_agent",
	tool: "execute_tool",
	skill: "pi.skill.load",
	monitor: "pi.monitor",
	notice: "anchorloop.close_guard.notice",
	evaluation: "gen_ai.evaluation.result",
	tools: "pi.tools.snapshot",
	skills: "pi.skills.available",
	compaction: "pi.compaction",
} as const;

export type SkillTrigger = "read" | "slash" | "declared" | "bash";
export type Label = "pass" | "fail" | "na";
