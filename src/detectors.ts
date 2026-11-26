/**
 * Process detectors over one session, fed entries in file order. Each yields a session-scoped
 * `gen_ai.evaluation.result` (annotator CODE). Commands and text are held in memory only while the
 * session is read; results carry fixed reason codes, never text.
 *
 * Anchor and change reading is ported from pi-anchorloop's close guard (`pi/close-guard.ts` `read()`,
 * MIT, Copyright (c) 2026 Wei Hung, anchorloop 3.3.0 at 7614445): the last `Anchor:` line or todo anchor,
 * backticked commands (a todo's bare value is one command), a change is a successful `write` or `edit`,
 * a bash run passes on exit code 0 (else on `isError` false), and a run matches an anchor command when it contains it.
 * Like the guard, an edit made through bash is not seen as a change.
 *
 * Unlike the guard, these read the other shapes agents state and run a check in (0.5.1, from human labels): an anchor
 * in the brief (`Anchor:`, `Gates:`, `Checks:`, or a check command it names), a labelled check line in the agent's
 * words (`驗證：`, `Verify:`), a todo's sb check spec, or a first change to a test file (red first); and a check run
 * in a monitor (by its exit code), passing evidence recorded after the last change, or, when no anchor command ran,
 * a test, build, lint or type-check run after it.
 */
import type { Label } from "./schema.ts";

/**
 * anchorloop 3.0.0 (one anchor rule and the close guard) reached this setup when weihung-basic-agent pinned it
 * (commit 9f72366, 2026-11-23T10:51:07Z). Sessions that started earlier are out of scope.
 */
export const ERA_START = "2026-11-23T10:51:07.000Z";
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

const LABEL = String.raw`(?:reality anchor|anchor|checks?|gates?|verify|verification|done when|驗證|檢查|驗收)`;
const LABELLED = new RegExp(String.raw`^[ \t>*_#-]*${LABEL}[*_]*\s*[:：][*_]*\s*(.+)$`, "gim");

function anchorLine(text: string): string | undefined {
	return [...text.matchAll(LABELLED)].at(-1)?.[1];
}

/** Tools and scripts whose run checks a change: tests, builds, linters, type checkers, and named check scripts. */
const RUNNER = new RegExp(
	[
		String.raw`(?:npm|pnpm|yarn|bun)(?:\s+--?[\w=.'"*/@-]+)*(?:\s+run)?(?:\s+-s)?(?:\s+--?[\w=.'"*/@-]+)*\s+(?:t|test|check|lint|build|typecheck|type-check|verify|e2e|gates?)(?:[:\w-]*)\b`,
		String.raw`(?:(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+dlx|uv\s+run(?:\s+--?[\w=-]+)*|poetry\s+run)\s+)?(?:vitest|jest|mocha|pytest|tsc|vue-tsc|eslint|ruff|mypy|pyright|biome|svelte-check|shellcheck|dprint\s+check|playwright\s+test|cypress\s+run|astro\s+check)\b`,
		String.raw`node\s+(?:--[\w-]+\s+)*--test\b`,
		String.raw`(?:deno|bun)\s+(?:test|check|lint)\b`,
		String.raw`(?:go\s+(?:test|vet|build)|cargo\s+(?:test|check|build|clippy)|dotnet\s+(?:test|build)|swift\s+(?:test|build)|make\s+(?:test|check|lint)|mvn\s+(?:test|verify)|\S*gradlew?\s+(?:test|build|check))\b`,
		String.raw`python3?(?:\s+-[A-Za-z]+)*\s+-m\s+(?:pytest|unittest|py_compile|mypy)\b`,
		String.raw`ansible-playbook\b.*--(?:check|syntax-check)\b`,
	].join("|"),
	"i",
);
/** A script whose name says it checks: scripts/check-links.mjs, gates.sh, measure.mjs, validate.py. */
const CHECK_SCRIPT = String.raw`(?:\S*/)?(?:[\w-]*[-_.])?(?:tests?|checks?|gates?|verify|validate|lint|measure)(?:[-_.][\w.-]*)?\.(?:py|sh|mjs|js|ts)\b`;
const INTERPRETER = String.raw`(?:(?:bash|sh|python3?|node|bun|uv\s+run(?:\s+--?[\w=-]+)*\s+python3?)(?:\s+-[A-Za-z]+)*\s+)`;
// A run: a runner, a check script, or any script under tests/ (python3 tests/overlay.py, tests/run.sh).
// A dotnet wrapper script that builds or tests: scripts/dev/dotnet-local.py test <project>.
const DOTNET_SCRIPT = String.raw`\S*dotnet[\w-]*\.py\s+(?:build|test)\b`;
const RUN_START = new RegExp(String.raw`^(?:(?:\S*/)?(?:${RUNNER.source})|${INTERPRETER}?(?:${CHECK_SCRIPT}|${DOTNET_SCRIPT}|\S*\btests?/\S+))`, "i");
// A mention in prose, as in a brief: a runner or a check script anywhere in a line.
const MENTION = new RegExp(String.raw`(?:^|[\s\x60("'>/])(?:${RUNNER.source}|${CHECK_SCRIPT})`, "im");
// Shell lead-ins stripped from each command segment before matching.
const LEAD = /^(?:[({!]\s*|(?:time|exec|command|nice|sudo\s+-n|timeout\s+\d+[smh]?|set\s+-\S+(?:\s+\S+)?)\s+|[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+)+/;

/** Whether a shell command runs a check: one of its `&&`, `||`, `;`, `|` or line segments starts with a check runner. */
export function isCheckRun(command: string): boolean {
	return command.split(/&&|\|\||[;|\n]/).some((part) => {
		const segment = part.trim().replace(LEAD, "");
		return segment.length > 0 && RUN_START.test(segment);
	});
}

// Prose a test run cannot check: a report, notes, a changelog. Writing one after the check does not undo the check.
const PROSE_FILE = /\.(?:md|markdown|txt|rst)$/i;
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|specs?)\/|[._-](?:test|spec)\.[A-Za-z]+$|_test\.(?:go|py|rb)$|(?:^|\/)test_[^/]+\.py$|Tests?\.cs$/;

type Part = { type?: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
interface Task { status?: string; evidence?: unknown }
type Entry = {
	type?: string;
	customType?: string;
	content?: unknown;
	data?: { v?: number; tasks?: Task[] };
	details?: { monitorOutcome?: { monitorId?: unknown; exitCode?: unknown } };
	message?: { role?: string; content?: unknown; toolCallId?: string; isError?: boolean; structuredContent?: { exit_code?: unknown } };
};

export class ProcessTracker {
	private seq = 0;
	private calls = new Map<string, { name: string; command?: string; path?: string; evidence?: boolean }>();
	private runs: { seq: number; command: string; ok: boolean }[] = [];
	private monitors = new Map<string, string>();
	private evidenceAt = -1;
	private anchor: string[] | undefined;
	private ownAnchor = false;
	private anchored: "anchor_first" | "anchor_in_brief" | "test_first" | undefined;
	private firstChange = -1;
	private lastChange = -1;
	private lastNonProse = -1;
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
		if (entry?.type === "custom_message" && entry.customType === "pi-loop-monitor") {
			const outcome = entry.details?.monitorOutcome;
			const command = outcome && this.monitors.get(String(outcome.monitorId));
			if (command && typeof outcome.exitCode === "number") this.pushRun(seq, command, outcome.exitCode === 0);
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
			const line = anchorLine(text);
			// The brief's anchor is the worker's anchor (anchorloop: "Put the unit's Anchor: line in the brief").
			if (line !== undefined) this.anchor = commandsOf(line, false);
			this.briefAnchor = line !== undefined || MENTION.test(text);
		} else if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content as Part[]) {
				if (part?.type === "text" && typeof part.text === "string") {
					const line = anchorLine(part.text);
					if (line !== undefined) this.setAnchor(commandsOf(line, false));
				} else if (part?.type === "toolCall" && typeof part.id === "string") {
					const args = part.arguments ?? {};
					const command = (part.name === "bash" || part.name === "MonitorCreate") && typeof args.command === "string" ? squeeze(args.command) : undefined;
					const path = typeof args.path === "string" ? args.path : undefined;
					let evidence = false;
					if (part.name === "todo") {
						const batch = Array.isArray(args.tasks) ? args.tasks : [];
						for (const item of [args, ...batch] as Record<string, unknown>[]) {
							const meta = item?.metadata as { anchor?: unknown; sb?: { spec?: { check?: { run?: unknown } } } } | undefined;
							const value = [item?.anchor, meta?.anchor].find((v) => typeof v === "string" && v.trim()) as string | undefined;
							const spec = meta?.sb?.spec?.check;
							if (value) this.setAnchor(commandsOf(value, true));
							else if (spec) this.setAnchor(typeof spec.run === "string" && spec.run.trim() ? [squeeze(spec.run)] : []);
							if (Array.isArray(item?.evidence) && item.evidence.some((e) => (e as { result?: unknown })?.result === "pass")) evidence = true;
						}
					}
					this.calls.set(part.id, { name: String(part.name), command, path, evidence });
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
					this.anchored = this.ownAnchor ? "anchor_first" : this.briefAnchor ? "anchor_in_brief" : call.path && TEST_FILE.test(call.path) ? "test_first" : undefined;
				}
				this.lastChange = seq;
				if (!call.path || !PROSE_FILE.test(call.path)) this.lastNonProse = seq;
			} else if (call.name === "bash" && call.command) {
				this.pushRun(seq, call.command, ok);
			} else if (call.name === "MonitorCreate" && call.command && ok) {
				const id = /Monitor #(\d+) started/.exec(resultText(message.content))?.[1];
				if (id) this.monitors.set(id, call.command);
			} else if (call.name === "todo" && call.evidence && ok) {
				this.evidenceAt = seq;
			}
		}
		return undefined;
	}

	private setAnchor(commands: string[]) {
		this.anchor = commands;
		this.ownAnchor = true;
	}

	private pushRun(seq: number, command: string, ok: boolean) {
		this.runs.push({ seq, command, ok });
		if (this.runs.length > MAX_RUNS) this.runs.splice(0, this.runs.length - MAX_RUNS);
	}

	results(inScope: boolean): DetectorResult[] {
		if (!inScope) return DETECTORS_ALL.map((name) => ({ name, label: "na", explanation: "out_of_scope_pre_3.0" }));
		return [this.anchorFirst(), this.checkAfter(), this.todoEvidence(), this.quiet()];
	}

	private anchorFirst(): DetectorResult {
		const name = "anchor_before_first_edit";
		if (this.firstChange < 0) return { name, label: "na", explanation: "no_edit" };
		if (this.anchored) return { name, label: "pass", explanation: this.anchored };
		return { name, label: "fail", explanation: "change_before_anchor" };
	}

	private checkAfter(): DetectorResult {
		const name = "check_after_last_edit";
		if (this.lastChange < 0) return { name, label: "na", explanation: "no_edit" };
		const prose = this.lastNonProse < 0;
		const last = prose ? this.lastChange : this.lastNonProse;
		const commands = this.anchor ?? [];
		const latest = commands.map((command) => this.runs.findLast((run) => run.command.includes(command)));
		if (commands.length && latest.every((run) => !!run && run.seq > last && run.ok)) return { name, label: "pass", explanation: "anchor_green" };
		if (this.evidenceAt > last) return { name, label: "pass", explanation: "evidence_after_change" };
		// An anchor command that ran after the change and failed is a failing check, whatever else passed.
		if (latest.some((run) => !!run && run.seq > last && !run.ok)) return { name, label: "fail", explanation: "no_passing_run_after_change" };
		const check = this.runs.findLast((run) => run.seq > last && isCheckRun(run.command));
		if (check) return check.ok ? { name, label: "pass", explanation: "check_run_after_change" } : { name, label: "fail", explanation: "no_passing_run_after_change" };
		if (prose) return { name, label: "na", explanation: "prose_only" };
		if (this.anchor && !commands.length) return { name, label: "na", explanation: "anchor_without_command" };
		return { name, label: "fail", explanation: commands.length ? "no_passing_run_after_change" : "no_check_after_change" };
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

function resultText(content: unknown): string {
	return Array.isArray(content) ? (content as Part[]).map((p) => (p?.type === "text" ? (p.text ?? "") : "")).join("\n") : String(content ?? "");
}
