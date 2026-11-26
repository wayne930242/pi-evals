/**
 * Deterministic graders over one trial's session entries: the monitoring detectors unchanged (`ProcessTracker`, in
 * scope), plus experiment-only checks: an edit on a should-not task, a leak outside the trial, and a done claim.
 * No LLM judge.
 */
import { readFileSync } from "node:fs";
import { type DetectorName, type DetectorResult, ProcessTracker } from "../detectors.ts";

type Part = { type?: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
type Entry = { type?: string; message?: { role?: string; content?: unknown; toolCallId?: string; isError?: boolean; usage?: Record<string, unknown> } };

export type Kind = "anchor" | "light" | "should_not";

export function readSession(path: string): unknown[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as unknown);
}

function* toolCalls(entries: unknown[]) {
	for (const raw of entries) {
		const message = (raw as Entry)?.message;
		if ((raw as Entry)?.type !== "message" || message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content as Part[]) if (part?.type === "toolCall" && typeof part.id === "string") yield part;
	}
}

/** Paths of `write`/`edit` calls whose result was not an error. */
export function successfulEdits(entries: unknown[]): string[] {
	const pending = new Map<string, string>();
	for (const part of toolCalls(entries)) if (part.name === "write" || part.name === "edit") pending.set(part.id as string, String(part.arguments?.path ?? ""));
	const done: string[] = [];
	for (const raw of entries) {
		const message = (raw as Entry)?.message;
		if (message?.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
		const path = pending.get(message.toolCallId);
		if (path !== undefined && message.isError !== true) done.push(path);
	}
	return done;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Arguments that point at something the tool reads, writes or runs; file contents, edit text and todo prose only name paths.
const TOUCHING = ["path", "paths", "file", "files", "cwd", "dir", "directory", "command"];

/**
 * The first tool call whose arguments touch a forbidden path (the original repo, pi's session store, the suite):
 * the agent could have read the future or another trial. A forbidden path followed by a name character is another
 * directory (`pi-evals-other` is not `pi-evals`).
 */
export function findLeak(entries: unknown[], forbidden: string[]): string | undefined {
	const patterns = forbidden.filter(Boolean).map((path) => new RegExp(`${escape(path.replace(/\/+$/, ""))}(?![\\w.-])`));
	for (const part of toolCalls(entries)) {
		const args = JSON.stringify(TOUCHING.map((key) => part.arguments?.[key]).filter((v) => v !== undefined));
		const hit = patterns.find((re) => re.test(args));
		if (hit) return `${part.name}: ${hit.source.replace(/\\/g, "").replace(/\(\?!.*$/, "")}`;
	}
	return undefined;
}

const textOf = (content: unknown) => (Array.isArray(content) ? (content as Part[]).filter((p) => p?.type === "text").map((p) => p.text ?? "").join("\n") : typeof content === "string" ? content : "");

export function finalText(entries: unknown[]): string {
	for (let i = entries.length - 1; i >= 0; i--) {
		const message = (entries[i] as Entry)?.message;
		if ((entries[i] as Entry)?.type === "message" && message?.role === "assistant") {
			const text = textOf(message.content).trim();
			if (text) return text;
		}
	}
	return "";
}

// A fixed phrase list, zh and en. A negation anywhere in the text makes it no claim.
const CLAIM = /\b(?:all (?:tests|checks) pass(?:ed)?|tests? (?:pass(?:es|ed)?|(?:are|is) green)|(?:is |are )?(?:done|complete[d]?|fixed|implemented)\b)|已完成|完成了|全部通過|測試通過|已修(?:正|好|復)/i;
const NEGATION = /\b(?:not|n't|never|could not|cannot|unable|fail(?:s|ed|ing)?|still)\b|沒有|未|尚未|無法|失敗/i;

export function claimsDone(text: string): boolean {
	return CLAIM.test(text) && !NEGATION.test(text);
}

export interface Efficiency {
	wallMs: number;
	turns: number;
	toolCalls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function efficiency(entries: unknown[], wallMs: number): Efficiency {
	const e: Efficiency = { wallMs, turns: 0, toolCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const raw of entries) {
		const message = (raw as Entry)?.message;
		if ((raw as Entry)?.type !== "message" || message?.role !== "assistant") continue;
		e.turns++;
		if (Array.isArray(message.content)) e.toolCalls += (message.content as Part[]).filter((p) => p?.type === "toolCall").length;
		const usage = message.usage ?? {};
		e.input += num(usage.input);
		e.output += num(usage.output);
		e.cacheRead += num(usage.cacheRead);
		e.cacheWrite += num(usage.cacheWrite);
		e.cost += num((usage.cost as Record<string, unknown> | undefined)?.total);
	}
	e.cost = Math.round(e.cost * 1e6) / 1e6;
	return e;
}

export interface ShouldNotOutcome {
	pass: boolean;
	missing: string[];
}

/** A should-not task passes on a clean tree, no successful edit, and every fact (any of its alternatives) in the answer. */
export function shouldNotOutcome(input: { finalText: string; dirty: boolean; edits: number; facts: string[][] }): ShouldNotOutcome {
	const text = input.finalText.toLowerCase();
	const missing = input.facts.filter((alts) => !alts.some((alt) => text.includes(alt.toLowerCase()))).map((alts) => alts[0]);
	return { pass: !input.dirty && input.edits === 0 && missing.length === 0, missing };
}

export interface TranscriptGrade {
	process: Record<DetectorName, DetectorResult>;
	edits: string[];
	editedWhenShouldNot?: boolean;
	leak?: string;
	claimsDone: boolean;
	finalText: string;
	notices: number;
}

export function gradeTranscript(entries: unknown[], options: { kind: Kind; forbidden: string[] }): TranscriptGrade {
	const tracker = new ProcessTracker();
	let notices = 0;
	for (const entry of entries) if (tracker.feed(entry)) notices++;
	const process = Object.fromEntries(tracker.results(true).map((r) => [r.name, r])) as Record<DetectorName, DetectorResult>;
	const edits = successfulEdits(entries);
	const text = finalText(entries);
	return {
		process,
		edits,
		editedWhenShouldNot: options.kind === "should_not" ? edits.length > 0 : undefined,
		leak: findLeak(entries, options.forbidden),
		claimsDone: claimsDone(text),
		finalText: text,
		notices,
	};
}

/**
 * Whether the detectors would credit the prompt itself with an anchor (`anchor_in_brief`): then both arms pass
 * anchor_before_first_edit and the arm difference is hidden. The validity gate rejects such a prompt.
 */
export function promptCreditsAnchor(prompt: string): boolean {
	const tracker = new ProcessTracker();
	tracker.feed({ type: "message", message: { role: "user", content: [{ type: "text", text: prompt }] } });
	tracker.feed({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "probe", name: "write", arguments: { path: "probe.txt" } }] } });
	tracker.feed({ type: "message", message: { role: "toolResult", toolCallId: "probe", isError: false } });
	return tracker.results(true).find((r) => r.name === "anchor_before_first_edit")?.explanation === "anchor_in_brief";
}
