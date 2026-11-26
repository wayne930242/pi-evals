/** Synthetic pi session files (JSONL v3) for tests. No real transcript content. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SECRET = "PLANTED SECRET 7f3a-cafe";
export const SECRET_TOKEN = "PLANTEDTOKEN7f3acafe";

let n = 0;
const id = () => `e${(++n).toString(16).padStart(7, "0")}`;
const at = (base: string, s: number) => new Date(Date.parse(base) + s * 1000).toISOString();

export interface SessionSpec {
	id: string;
	cwd: string;
	start: string;
	entries: (t: (s: number) => string) => Record<string, unknown>[];
}

export function sessionLines(spec: SessionSpec): string {
	const t = (s: number) => at(spec.start, s);
	let parent: string | null = null;
	const lines = [{ type: "session", version: 3, id: spec.id, timestamp: spec.start, cwd: spec.cwd }];
	for (const e of spec.entries(t)) {
		const eid = (e.id as string) ?? id();
		lines.push({ ...e, id: eid, parentId: "parentId" in e ? e.parentId : parent } as never);
		parent = eid;
	}
	return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

export const user = (ts: string, text: string) => ({ type: "message", timestamp: ts, message: { role: "user", content: [{ type: "text", text }], timestamp: Date.parse(ts) } });
export const assistant = (ts: string, content: unknown[], cost = 0.01, model = "claude-opus-5-5") => ({
	type: "message",
	timestamp: ts,
	message: { role: "assistant", provider: "claude-bridge", model, content, usage: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 10, totalTokens: 1160, cost: { total: cost } }, stopReason: "toolUse" },
});
export const call = (callId: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id: callId, name, arguments: args });
export const result = (ts: string, callId: string, toolName: string, opts: { isError?: boolean; durationMs?: number; details?: unknown; text?: string; exit?: number } = {}) => ({
	type: "message",
	timestamp: ts,
	message: {
		role: "toolResult",
		toolCallId: callId,
		toolName,
		content: [{ type: "text", text: opts.text ?? "ok" }],
		isError: opts.isError ?? false,
		...(opts.durationMs === undefined ? {} : { durationMs: opts.durationMs }),
		...(opts.details === undefined ? {} : { details: opts.details }),
		...(opts.exit === undefined ? {} : { structuredContent: { exit_code: opts.exit } }),
	},
});
export const custom = (ts: string, customType: string, data: unknown) => ({ type: "custom", timestamp: ts, customType, data });
export const todo = (ts: string, tasks: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({ type: "custom", timestamp: ts, customType: "todo/v1", data: { v: 1, tasks, nextId: tasks.reduce((m, t) => Math.max(m, Number(t.id) + 1), 1) }, ...extra });
export const stop = (ts: string, cost = 0) => ({ ...assistant(ts, [{ type: "text", text: "done" }], cost), message: { ...assistant(ts, [], cost).message, content: [{ type: "text", text: "done" }], stopReason: "stop" } });
export const customMessage = (ts: string, customType: string, content: string, details?: unknown) => ({ type: "custom_message", timestamp: ts, customType, content, display: false, details });

/** A session in the anchorloop 3.x era that touches every extracted feature, with the secret planted in every text field. */
export function richSession(home: string, sessionId = "01a20000-0000-7000-8000-000000000001", start = "2026-11-24T10:00:00.000Z"): SessionSpec {
	return {
		id: sessionId,
		cwd: join(home, "projects", "demo-repo"),
		start,
		entries: (t) => [
			{ type: "model_change", timestamp: t(0), provider: "claude-bridge", modelId: "claude-opus-5-5" },
			{ type: "message", timestamp: t(0), message: { role: "system", content: [], sections: { skills: `<skills>\n<available_skills>\n<skill>\n<name>coding</name>\n<description>${SECRET}</description>\n</skill>\n<skill>\n<name>unused-skill</name>\n<description>x</description>\n</skill>\n</available_skills></skills>` } } },
			user(t(1), `Please fix the bug. ${SECRET}`),
			assistant(t(2), [{ type: "thinking", thinking: SECRET }, { type: "text", text: `Plan ${SECRET}\nAnchor: \`npm test\`` }, call("c-read", "read", { path: join(home, ".agents/skills/coding/SKILL.md") })]),
			result(t(3), "c-read", "read", { durationMs: 12, text: `---\nname: coding\n---\n${SECRET}` }),
			assistant(t(4), [call("c-edit", "edit", { path: "src/a.ts", edits: [{ oldText: SECRET, newText: SECRET_TOKEN }] })]),
			result(t(5), "c-edit", "edit", { durationMs: 30 }),
			assistant(t(6), [call("c-bash", "bash", { command: `npm test # ${SECRET}` })]),
			result(t(9), "c-bash", "bash", { text: SECRET, exit: 0 }),
			assistant(t(10), [call("c-ask", "ask_user_question", { questions: [{ question: SECRET, header: "h", options: [{ label: SECRET, description: SECRET }] }] })]),
			result(t(70), "c-ask", "ask_user_question", { durationMs: 60_000, details: { answers: [{ questionIndex: 0, question: SECRET, kind: "custom", answer: SECRET }], cancelled: false }, text: SECRET }),
			assistant(t(71), [call("c-ask-old", "ask_user", { question: SECRET, context: SECRET })]),
			result(t(80), "c-ask-old", "ask_user", { details: { cancelled: true, question: SECRET, options: [SECRET], response: null } }),
			assistant(t(81), [call("c-mon", "MonitorCreate", { command: `sleep 1 # ${SECRET}`, description: SECRET })]),
			result(t(82), "c-mon", "MonitorCreate", { durationMs: 25, details: { kind: "monitor", summary: `Monitor #4 running · ${SECRET}` }, text: "Monitor #4 started" }),
			customMessage(t(142), "pi-loop-monitor", `[pi-loop-monitor] ${SECRET}`, { deliveryGroup: "monitor-terminal", monitorId: "4", monitorOutcome: { monitorId: "4", status: "completed", exitCode: 0, outputLines: 3 } }),
			assistant(t(143), [call("c-sub", "subagent", { agent: `reviewer ${SECRET}`, model: "openai/gpt-6.2-sol", task: SECRET })]),
			result(t(144), "c-sub", "subagent", { durationMs: 74, details: { id: "11111111-2222-4333-8444-555555555555", name: SECRET, agent: "reviewer", model: "openai/gpt-6.2-sol", task: SECRET, sessionFile: `/x/${SECRET}.jsonl` } }),
			customMessage(t(145), "pi-herdr-agents:declared-skills", `<skill name="agent-terse" location="/x/SKILL.md">${SECRET}</skill>`),
			custom(t(146), "todo/v1", { v: 1, nextId: 3, tasks: [{ id: 1, subject: `${SECRET} ${"x".repeat(80)} ${SECRET_TOKEN}`, description: SECRET, activeForm: SECRET, anchor: SECRET, owner: SECRET, status: "completed", evidence: [{ command: SECRET, sha: SECRET_TOKEN, ref: SECRET_TOKEN, result: "pass", at: t(146) }] }, { id: 2, subject: SECRET, status: "completed" }] }),
			customMessage(t(147), "anchorloop-close-guard", "anchorloop: no passing run of `npm test` after the last change."),
			{ type: "compaction", timestamp: t(148), summary: SECRET, firstKeptEntryId: "e1", tokensBefore: 1000 },
			user(t(150), `<skill name="investigating" location="/y/SKILL.md">\n${SECRET}\n</skill>\n\n${SECRET}`),
			assistant(t(151), [{ type: "text", text: SECRET }], 0.02),
		],
	};
}

/** A subagent child session, launched by `richSession`, whose brief names the parent's artifacts dir. */
export function childSession(home: string, parentId = "01a20000-0000-7000-8000-000000000001"): { spec: SessionSpec; file: string } {
	return {
		file: "2026-11-24T10-05-00-000Z_11111111-2222-4333-8444-555555555555-aaaaaaaa-bbbbbbbb-cccc.jsonl",
		spec: {
			id: "01a20000-0000-7000-8000-0000000000c1",
			cwd: join(home, ".herdr-worktrees", "demo-repo-fix-thing"),
			start: "2026-11-24T10:05:00.000Z",
			entries: (t) => [
				user(t(0), `<file name="${home}/.pi/agent/sessions/--x--/artifacts/${parentId}/context/review-1.md">\n${SECRET}\n</file>`),
				assistant(t(1), [call("k1", "bash", { command: `git diff # ${SECRET}` })], 0.5),
				result(t(2), "k1", "bash", { exit: 1, isError: true }),
			],
		},
	};
}

/** Writes sessions under `<agentDir>/sessions/<dir>/<file>`; returns the agent dir. */
export function writeAgentDir(files: { dir: string; file: string; spec: SessionSpec }[], root = mkdtempSync(join(tmpdir(), "pi-evals-agent-"))): string {
	for (const f of files) {
		const dir = join(root, "sessions", f.dir);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, f.file), sessionLines(f.spec));
	}
	return root;
}
