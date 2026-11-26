/**
 * The change timeline: architecture changes the boss makes, from git history (read-only `git log`), version
 * changes seen in live tool-owner snapshots, and manual marks (`/evals mark`).
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { EvalRecord } from "./schema.ts";

export type ChangeKind = "pin" | "model-routing" | "rule" | "skill" | "agent-role" | "manual";

export interface Change {
	at: string;
	kind: ChangeKind;
	subject: string;
	package?: string;
	from?: string;
	to?: string;
	sha?: string;
	repo?: string;
	source: "git" | "live" | "mark";
}

const PIN_FILE = "scripts/pi_root/pins.py";

/** Which kind of architecture change a repository path is, if any. */
export function classifyPath(path: string): Exclude<ChangeKind, "pin" | "manual"> | "pin" | undefined {
	if (path === PIN_FILE) return "pin";
	if (/(^|\/)herdr-agents-models[^/]*\.json$/.test(path) || /^pi\/models\.json$/.test(path)) return "model-routing";
	if (/^rules\//.test(path) || /^pi\/AGENTS[^/]*\.md(\.in)?$/.test(path)) return "rule";
	if (/^agents\//.test(path)) return "agent-role";
	if (/^skills\//.test(path) || path === "overlay.json") return "skill";
	return undefined;
}

const SPEC = /npm:((?:@[\w.-]+\/)?[\w.-]+)@([\w.+-]+)|git:github\.com\/[\w.-]+\/([\w.-]+)@([0-9a-f]{7,40})/g;

/** Package versions named on one side of a diff. */
function specs(lines: string[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of lines) {
		for (const m of line.matchAll(SPEC)) {
			if (m[1]) out.set(m[1], m[2]);
			else if (m[3]) out.set(m[3], m[4].slice(0, 7));
		}
	}
	return out;
}

/** Pin changes in one commit's `-U0` diff of pins.py. */
export function pinChanges(diff: string): { package: string; from?: string; to?: string }[] {
	const removed = specs(diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")));
	const added = specs(diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")));
	const out: { package: string; from?: string; to?: string }[] = [];
	for (const [name, to] of added) if (removed.get(name) !== to) out.push({ package: name, from: removed.get(name), to });
	for (const [name, from] of removed) if (!added.has(name)) out.push({ package: name, from });
	return out;
}

function git(repo: string, args: string[]): string {
	const res = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 256 << 20 });
	if (res.status !== 0) throw new Error(`git ${args[0]} in ${repo} failed: ${res.stderr.trim()}`);
	return res.stdout;
}

/** Changes from one repository's history. A missing repository yields none. */
export function gitChanges(repo: string): Change[] {
	if (!existsSync(repo)) return [];
	const name = basename(repo);
	const out: Change[] = [];
	const log = git(repo, ["log", "--format=%x1e%H%x1f%cI%x1f%s", "--name-only", "--no-merges"]);
	for (const block of log.split("\x1e").slice(1)) {
		const [head, ...files] = block.split("\n");
		const [sha, at, subject] = head.split("\x1f");
		const kinds = new Set(files.map((f) => f.trim()).filter(Boolean).map(classifyPath).filter((k) => k && k !== "pin"));
		for (const kind of kinds) out.push({ at: new Date(at).toISOString(), kind: kind as ChangeKind, subject, sha: sha.slice(0, 12), repo: name, source: "git" });
	}
	if (existsSync(`${repo}/${PIN_FILE}`) || git(repo, ["log", "-1", "--format=%H", "--", PIN_FILE]).trim()) {
		const pins = git(repo, ["log", "-p", "-U0", "--no-merges", "--format=%x1e%H%x1f%cI%x1f%s", "--", PIN_FILE]);
		for (const block of pins.split("\x1e").slice(1)) {
			const nl = block.indexOf("\n");
			const [sha, at, subject] = block.slice(0, nl).split("\x1f");
			for (const change of pinChanges(block.slice(nl + 1))) {
				out.push({ at: new Date(at).toISOString(), kind: "pin", subject, ...change, sha: sha.slice(0, 12), repo: name, source: "git" });
			}
		}
	}
	return out;
}

/** Version changes between consecutive live tool-owner snapshots, per package. */
export function liveChanges(snapshots: EvalRecord[]): Change[] {
	const last = new Map<string, string>();
	const out: Change[] = [];
	for (const rec of [...snapshots].sort((a, b) => a.ts.localeCompare(b.ts))) {
		const tools = rec.attrs["pi.tools"];
		if (!Array.isArray(tools)) continue;
		const versions = new Map<string, string>();
		for (const entry of tools) {
			const owner = entry.slice(entry.indexOf("=") + 1);
			const at = owner.lastIndexOf("@");
			if (at > 0) versions.set(owner.slice(0, at), owner.slice(at + 1));
		}
		for (const [pkg, version] of versions) {
			const before = last.get(pkg);
			if (before && before !== version) out.push({ at: rec.ts, kind: "pin", subject: `${pkg} ${before} → ${version} (seen live)`, package: pkg, from: before, to: version, source: "live" });
			last.set(pkg, version);
		}
	}
	return out;
}

export function readMarks(file: string): Change[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				const m = JSON.parse(line) as { at: string; text: string };
				return [{ at: m.at, kind: "manual" as const, subject: m.text, source: "mark" as const }];
			} catch {
				return [];
			}
		});
}

export function addMark(file: string, text: string, at = new Date()): Change {
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${JSON.stringify({ at: at.toISOString(), text })}\n`);
	return { at: at.toISOString(), kind: "manual", subject: text, source: "mark" };
}

/**
 * All changes, oldest first; a live version change already pinned in git within three days before is dropped.
 * A repository whose history cannot be read is reported through `errors` and skipped.
 */
export function buildChanges(repos: string[], snapshots: EvalRecord[], marksFile: string, errors: string[] = []): Change[] {
	const fromGit = repos.flatMap((repo) => {
		try {
			return gitChanges(repo);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
			return [];
		}
	});
	const live = liveChanges(snapshots).filter(
		(c) => !fromGit.some((g) => g.kind === "pin" && g.package === c.package && g.to === c.to && Date.parse(c.at) - Date.parse(g.at) < 3 * 86_400_000 && Date.parse(c.at) >= Date.parse(g.at)),
	);
	return [...fromGit, ...live, ...readMarks(marksFile)].sort((a, b) => a.at.localeCompare(b.at));
}

export function writeChanges(file: string, changes: Change[]): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, changes.map((c) => `${JSON.stringify(c)}\n`).join(""));
	renameSync(tmp, file);
}

export function readChanges(file: string): Change[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Change);
}

/** The version of a package in effect at an ISO time: the newest pin change at or before it (changes oldest first). */
export function versionAt(changes: Change[], pkg: string | string[], at: string): string | undefined {
	const names = Array.isArray(pkg) ? pkg : [pkg];
	let version: string | undefined;
	for (const c of changes) {
		if (c.kind !== "pin" || !c.package || !names.includes(c.package)) continue;
		if (c.at > at) break;
		version = c.to ?? version;
	}
	return version;
}
