/**
 * Which package owns a tool. Live sessions record it from `pi.getAllTools()` sourceInfo (canonical);
 * past sessions fall back to the newest live snapshot, then to this static table (scratch/evals/instrumentation.md §2).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const BUILTIN_TOOLS = new Set(["bash", "read", "edit", "write", "grep", "find", "ls"]);

const STATIC: Record<string, string> = {
	ask_user_question: "@juicesharp/rpiv-ask-user-question",
	ask_user: "pi-ask-user",
	todo: "pi-todo-ledger",
	show_doc: "pi-better-show",
	intercom: "pi-intercom",
	contact_supervisor: "pi-intercom",
	robot_hand: "pi-robot-hand",
	secret_drop: "pi-robot-hand",
	prose_watch: "pi-prose-watch",
	mcp: "pi-mcp-adapter",
	web_search: "pi-web-access",
	fetch_content: "pi-web-access",
	get_search_content: "pi-web-access",
	source_check: "pi-web-access",
	web_enable: "pi-web-access",
	call_tower: "pi-straw-boss",
	train_car: "pi-straw-boss",
	ally_escalate: "pi-straw-boss",
	evals_query: "pi-evals",
};

const PREFIX: [RegExp, string][] = [
	[/^(Monitor|Loop)(Create|List|Update|Stop|Delete)$/, "pi-loop-monitor"],
	[/^(subagent|subagents_list|worktree_list|worktree_remove|caller_ping|caller_notify|subagent_done)/, "pi-herdr-agents"],
	[/^(boss|tower|thread|board)_/, "pi-straw-boss"],
	[/^memory_/, "@pify/memory"],
	[/^codex_/, "pi-codex-image-gen"],
	[/^goal_/, "@narumitw/pi-goal"],
	// Retired or renamed packages that appear in older sessions.
	[/^anchorloop_/, "pi-anchorloop"],
	[/^aaaav_/, "pi-aaaav"],
	[/^lens_/, "pi-lens"],
	[/^(google_search|read_url_content)$/, "pi-antigravity"],
];

/** The owner of a tool by name, when no live snapshot knows it. */
export function staticOwner(tool: string): string {
	if (BUILTIN_TOOLS.has(tool)) return "pi:builtin";
	if (STATIC[tool]) return STATIC[tool];
	for (const [pattern, owner] of PREFIX) if (pattern.test(tool)) return owner;
	return "unknown";
}

const packageCache = new Map<string, { name: string; version?: string } | undefined>();

/** The nearest package.json above a source path: its name and version. */
export function packageOf(path: string | undefined): { name: string; version?: string } | undefined {
	if (!path || path.startsWith("builtin:") || path.startsWith("<")) return undefined;
	let dir = dirname(path);
	const seen: string[] = [];
	for (let i = 0; i < 12 && dir && dir !== dirname(dir); i++, dir = dirname(dir)) {
		if (packageCache.has(dir)) {
			const hit = packageCache.get(dir);
			for (const d of seen) packageCache.set(d, hit);
			return hit;
		}
		seen.push(dir);
		const file = join(dir, "package.json");
		if (existsSync(file)) {
			try {
				const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string };
				if (pkg.name) {
					const hit = { name: pkg.name, version: pkg.version };
					for (const d of seen) packageCache.set(d, hit);
					return hit;
				}
			} catch {}
		}
	}
	for (const d of seen) packageCache.set(d, undefined);
	return undefined;
}

/** `name=owner@version` for one tool from its sourceInfo. */
export function ownerOf(tool: { name: string; sourceInfo?: { path?: string; source?: string } }): { owner: string; version?: string } {
	const info = tool.sourceInfo;
	if (!info || info.source === "builtin") return { owner: info?.path?.startsWith("builtin:") && !BUILTIN_TOOLS.has(tool.name) ? info.path : "pi:builtin" };
	if (info.source === "sdk") return { owner: "sdk" };
	const pkg = packageOf(info.path);
	if (pkg) return { owner: pkg.name, version: pkg.version };
	return { owner: info.source && info.source !== "local" ? info.source : "local-extension" };
}
