/**
 * The turn a command's own message starts: armed when the command sends it, open from the moment that message starts
 * the run (`before_agent_start`, or its user message when it was queued behind a running turn), and closed at
 * `agent_end`, on another message from the user, or at a new session.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface Turn<T> {
	session: string;
	prompt: string;
	data: T;
}

export const textOf = (content: unknown) =>
	typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("") : "";

export function turnWindow<T>(pi: ExtensionAPI) {
	let waiting: Turn<T> | undefined;
	let open: Turn<T> | undefined;
	const start = (text: string | undefined) => {
		if (waiting && text === waiting.prompt) {
			open = waiting;
			waiting = undefined;
		}
	};
	pi.on("before_agent_start", (event) => start((event as { prompt?: string }).prompt));
	pi.on("message_end", (event) => {
		const message = (event as { message?: { role?: string; content?: unknown } }).message;
		if (message?.role !== "user") return;
		const text = textOf(message.content);
		if (open && text !== open.prompt) open = undefined;
		start(text);
	});
	pi.on("agent_end", () => {
		open = undefined;
	});
	pi.on("session_start", () => {
		waiting = open = undefined;
	});
	return {
		/** The message the command is about to send; its turn opens when that message starts a run. */
		arm(turn: Turn<T>) {
			waiting = turn;
		},
		/** The open turn of this session, if any. */
		current(session: string): Turn<T> | undefined {
			return open?.session === session ? open : undefined;
		},
	};
}
