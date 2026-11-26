/** A short project key for a working directory: the repository name, never the full path. */
import { readdirSync } from "node:fs";
import { join, sep } from "node:path";

let known: string[] | undefined;

/** Repository names under ~/projects, longest first, so a worktree name maps to the longest matching repo. */
function knownProjects(home: string): string[] {
	if (!known) {
		try {
			known = readdirSync(join(home, "projects"), { withFileTypes: true })
				.filter((d) => d.isDirectory() && !d.name.startsWith("."))
				.map((d) => d.name)
				.sort((a, b) => b.length - a.length);
		} catch {
			known = [];
		}
	}
	return known;
}

/** For tests: replace the known repository names. */
export function setKnownProjects(names: string[] | undefined): void {
	known = names ? [...names].sort((a, b) => b.length - a.length) : undefined;
}

export function projectKey(cwd: string | undefined, home: string): string {
	if (!cwd) return "unknown";
	const rel = cwd === home ? "" : cwd.startsWith(home + sep) ? cwd.slice(home.length + 1) : undefined;
	if (rel === undefined) {
		const first = cwd.split(sep).filter(Boolean)[0];
		return first === "tmp" || first === "private" || first === "var" ? "tmp" : "other";
	}
	if (rel === "") return "home";
	const parts = rel.split(sep);
	if (parts[0] === "projects" && parts[1]) return parts[1];
	if (parts[0] === ".herdr-worktrees" && parts[1]) {
		const name = parts[1];
		const repo = knownProjects(home).find((p) => name === p || name.startsWith(`${p}-`));
		return repo ?? name.split("-")[0] ?? "worktree";
	}
	return parts[0].startsWith(".") ? parts[0].slice(1) || "home" : parts[0];
}
