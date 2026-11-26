/**
 * `/ask-ai <question>`: the user asks, and the agent answers now. The question goes to the agent wrapped in a short
 * answer-first instruction, and while that turn runs the tools that change things or start work are refused, so a
 * question is not taken for a reproach and turned into new work before the user can label how it went.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { appendAsk } from "./asks.ts";
import { itemOnBranch } from "./labels.ts";
import { context } from "./ops.ts";
import { projectKey } from "./project.ts";
import { turnWindow } from "./turn-window.ts";

type Env = Record<string, string | undefined>;
type Input = Record<string, unknown>;

const always = () => true;
/** Tools refused during an `/ask-ai` turn, each with the inputs it is refused for; any other tool runs. */
export const ASK_AI_BLOCKED: Readonly<Record<string, (input: Input) => boolean>> = {
	write: always,
	edit: always,
	subagent: always,
	boss_pair: always,
	MonitorCreate: always,
	LoopCreate: always,
	call_tower: always,
	todo: (input) => input.action !== "list" && input.action !== "get",
	intercom: (input) => input.action === "send" || input.action === "ask" || input.action === "handover",
};

const USAGE = "pi-evals 用法：/ask-ai <你的問題>，代理人會先直接回答，不改任何東西、不開始新工作。";

/** The question, last and verbatim, after the instruction to answer it now and do nothing else. */
export function askPrompt(question: string): string {
	return [
		"[/ask-ai] Answer the user's question below now, directly and first, in the user's language. Read only what you need to answer; change nothing, start no work, dispatch nothing. If it asks how you worked, say plainly what happened and whether it followed the rule. End with at most one line of suggested next step, then wait for the user.",
		"",
		`Question: ${question}`,
	].join("\n");
}

export function askAi(pi: ExtensionAPI, options: { env: Env; now: () => number }) {
	const { env, now } = options;
	const asking = turnWindow<undefined>(pi);

	pi.on("tool_call", (event, ctx) => {
		const { toolName, input } = event as { toolName: string; input?: Input };
		const refuse = Object.hasOwn(ASK_AI_BLOCKED, toolName) ? ASK_AI_BLOCKED[toolName] : undefined;
		if (!refuse || !refuse(input ?? {}) || !asking.current(ctx.sessionManager.getSessionId())) return undefined;
		return { block: true, reason: `Refused during /ask-ai: answer the user's question first, change nothing and start no work; ${toolName} can run after the user replies.` };
	});

	pi.registerCommand("ask-ai", {
		description: "Ask the agent a question and have it answer now, without starting work: /ask-ai <question>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const question = args.trim();
			if (!question) return ctx.ui.notify(USAGE, "warning");
			const c = context(env);
			const session = ctx.sessionManager.getSessionId();
			let branch: unknown[] | undefined;
			try {
				branch = ctx.sessionManager.getBranch?.();
			} catch {}
			appendAsk(c.layout.asks, { session_id: session, at: new Date(now()).toISOString(), kind: "ask_ai", project: projectKey(ctx.cwd, c.home), item: itemOnBranch(branch, session) });
			const prompt = askPrompt(question);
			asking.arm({ session, prompt, data: undefined });
			// While the agent works, the question goes in after its current tool calls, not after the whole run.
			pi.sendUserMessage(prompt, ctx.isIdle() ? undefined : { deliverAs: "steer" });
		},
	});
}
