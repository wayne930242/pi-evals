/**
 * Process detectors over one session, fed entries in file order. Each yields a session-scoped
 * `gen_ai.evaluation.result` (annotator CODE). Commands and text are held in memory only while the
 * session is read; results carry fixed reason codes, never text.
 *
 * Anchor and change reading is ported from pi-anchorloop's close guard (`pi/close-guard.ts` `read()`,
 * MIT, Copyright (c) 2026 Wei Hung, anchorloop 3.3.0 at 7614445): the last `Anchor:` line or todo anchor,
 * backticked commands (a todo's bare value is one command), a change is a successful `write` or `edit`,
 * a bash run passes on exit code 0 (else on `isError` false), and a run matches an anchor command when it contains it.
 * Like the guard, an edit made through bash is not seen as a change. Unlike the guard, an Anchor stated only in the
 * first user message (a subagent's brief) is reported as `anchor_only_in_brief`, still a fail: the rule asks the
 * agent to state it.
 */
import type { Label } from "./schema.ts";

/** anchorloop 3.0.0 (one anchor rule and the close guard) shipped on this UTC day; older sessions are out of scope. */
export const ERA_START = "2026-11-23";
export const DETECTORS = ["anchor_before_first_edit", "check_after_last_edit", "todo_evidence", "close_guard_quiet"] as const;
export type DetectorName = (typeof DETECTORS)[number];
export interface DetectorResult {
	name: DetectorName;
	label: Label;
	/** Share in [0, 1] where the detector measures a share (todo_evidence). */
	value?: number;
	/** A fixed reason code. */
	explanation: string;
}
export type NoticeKind = "no_anchor" | "no_passing_run" | "evidence_handoff" | "other";

const NOTICE_TYPE = "anchorloop-close-guard";
const MAX_RUNS = 5000;

export function noticeKind(text: unknown): NoticeKind {
	if (typeof text !== "string") return "other";
	if (/no `Anchor: <check>` line was stated/.test(text)) return "no_anchor";
	if (/no passing run of /.test(text)) return "no_passing_run";
	if (/use todo update on #\d+ to append/.test(text)) return "evidence_handoff";
	return "other";
}

const squeeze = (text: string) => text.replace(/[ \t]+/g, " ").trim();

function commandsOf(text: string, bare: boolean): string[] {
	const ticked = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => squeeze(m[1])).filter(Boolean);
	return ticked.length || !bare ? ticked : [squeeze(text)].filter(Boolean);
}

function anchorLine(text: string): string | undefined {
	const lines = [...text.matchAll(/^[ \t>*_-]*(?:reality )?anchor[*_]*:[*_]*\s*(.+)$/gim)];
	return lines.at(-1)?.[1];
}

type Part = { type?: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
interface Task { status?: string; evidence?: unknown }
type Entry = {
	type?: string;
	customType?: string;
	content?: unknown;
	data?: { v?: number; tasks?: Task[] };
	message?: { role?: string; content?: unknown; toolCallId?: string; isError?: boolean; structuredContent?: { exit_code?: unknown } };
};

export class ProcessTracker {
	private seq = 0;
	private calls = new Map<string, { name: string; command?: string }>();
	private runs: { seq: number; command: string; ok: boolean }[] = [];
	private anchor: string[] | undefined;
	private anchoredBeforeChange = false;
	private firstChange = -1;
	private lastChange = -1;
	private tasks: Task[] | undefined;
	private sawUser = false;
	private briefAnchor = false;
	private notices = new Map<NoticeKind, number>();

	/** Notice kinds seen so far, for `anchorloop.close_guard.notice` records. */
	feed(raw: unknown): NoticeKind | undefined {
		const entry = raw as Entry;
		const seq = ++this.seq;
		if (entry?.type === "custom" && entry.customType === "todo/v1" && entry.data?.v === 1 && Array.isArray(entry.data.tasks)) {
			this.tasks = entry.data.tasks;
			return undefined;
		}
		if (entry?.type === "custom_message" && entry.customType === NOTICE_TYPE) {
			const kind = noticeKind(entry.content);
			this.notices.set(kind, (this.notices.get(kind) ?? 0) + 1);
			return kind;
		}
		const message = entry?.message;
		if (entry?.type !== "message" || !message) return undefined;
		if (message.role === "user" && !this.sawUser) {
			this.sawUser = true;
			const text = Array.isArray(message.content) ? (message.content as Part[]).map((p) => (p?.type === "text" ? (p.text ?? "") : "")).join("\n") : String(message.content ?? "");
			this.briefAnchor = anchorLine(text) !== undefined;
		} else if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content as Part[]) {
				if (part?.type === "text" && typeof part.text === "string") {
					const line = anchorLine(part.text);
					if (line !== undefined) this.setAnchor(commandsOf(line, false));
				} else if (part?.type === "toolCall" && typeof part.id === "string") {
					const command = part.name === "bash" && typeof part.arguments?.command === "string" ? squeeze(part.arguments.command) : undefined;
					this.calls.set(part.id, { name: String(part.name), command });
					if (part.name === "todo" && part.arguments) {
						const batch = Array.isArray(part.arguments.tasks) ? part.arguments.tasks : [];
						for (const item of [part.arguments, ...batch] as Record<string, unknown>[]) {
							const meta = item?.metadata as Record<string, unknown> | undefined;
							const value = [item?.anchor, meta?.anchor].find((v) => typeof v === "string" && v.trim()) as string | undefined;
							if (value) this.setAnchor(commandsOf(value, true));
						}
					}
				}
			}
		} else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			const call = this.calls.get(message.toolCallId);
			if (!call) return undefined;
			this.calls.delete(message.toolCallId);
			const code = message.structuredContent?.exit_code;
			const ok = typeof code === "number" ? code === 0 : message.isError !== true;
			if ((call.name === "write" || call.name === "edit") && ok) {
				if (this.firstChange < 0) {
					this.firstChange = seq;
					this.anchoredBeforeChange = this.anchor !== undefined;
				}
				this.lastChange = seq;
			} else if (call.name === "bash" && call.command) {
				this.runs.push({ seq, command: call.command, ok });
				if (this.runs.length > MAX_RUNS) this.runs.splice(0, this.runs.length - MAX_RUNS);
			}
		}
		return undefined;
	}

	private setAnchor(commands: string[]) {
		this.anchor = commands;
	}

	results(inScope: boolean): DetectorResult[] {
		if (!inScope) return DETECTORS_ALL.map((name) => ({ name, label: "na", explanation: "out_of_scope_pre_3.0" }));
		return [this.anchorFirst(), this.checkAfter(), this.todoEvidence(), this.quiet()];
	}

	private anchorFirst(): DetectorResult {
		const name = "anchor_before_first_edit";
		if (this.firstChange < 0) return { name, label: "na", explanation: "no_edit" };
		if (this.anchoredBeforeChange) return { name, label: "pass", explanation: "anchor_first" };
		return { name, label: "fail", explanation: this.briefAnchor ? "anchor_only_in_brief" : "change_before_anchor" };
	}

	private checkAfter(): DetectorResult {
		const name = "check_after_last_edit";
		if (this.lastChange < 0) return { name, label: "na", explanation: "no_edit" };
		if (!this.anchor) return { name, label: "na", explanation: "no_anchor" };
		if (!this.anchor.length) return { name, label: "na", explanation: "anchor_without_command" };
		const green = this.anchor.every((command) => {
			const last = this.runs.findLast((run) => run.command.includes(command));
			return !!last && last.seq > this.lastChange && last.ok;
		});
		return green ? { name, label: "pass", explanation: "anchor_green" } : { name, label: "fail", explanation: "no_passing_run_after_change" };
	}

	private todoEvidence(): DetectorResult {
		const name = "todo_evidence";
		const done = (this.tasks ?? []).filter((t) => t?.status === "completed");
		if (!done.length) return { name, label: "na", explanation: "no_completed_task" };
		const withEvidence = done.filter((t) => Array.isArray(t.evidence) && t.evidence.length > 0).length;
		const value = withEvidence / done.length;
		return { name, label: value === 1 ? "pass" : "fail", value, explanation: value === 1 ? "all_evidenced" : "completed_without_evidence" };
	}

	private quiet(): DetectorResult {
		const name = "close_guard_quiet";
		if (this.firstChange < 0) return { name, label: "na", explanation: "no_edit" };
		// An evidence hand-off asks the agent to record a run that passed; it is not a missing or failing check.
		const top = [...this.notices].filter(([kind]) => kind !== "evidence_handoff").sort((a, b) => b[1] - a[1])[0];
		return top ? { name, label: "fail", explanation: top[0] } : { name, label: "pass", explanation: "no_notice" };
	}
}

const DETECTORS_ALL: DetectorName[] = [...DETECTORS];
