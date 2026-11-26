/** Recognising skill loads, and listing the skills pi offers. */
import { posix } from "node:path";

const named = (name: string | undefined) => !!name && name !== "." && name !== "..";
export interface SkillHit {
	skill: string;
	/** Skill-relative path of a file other than SKILL.md (a playbook, reference, script). */
	resource?: string;
}

/** A read of `<dir>/SKILL.md` loads skill `<dir>`; a read under `skills/<name>/` reads one of its resources. */
export function skillFromPath(path: unknown): SkillHit | undefined {
	if (typeof path !== "string" || !path) return undefined;
	const normal = posix.normalize(path.replace(/\\/g, "/"));
	const load = normal.match(/(?:^|\/)([^/]+)\/SKILL\.md$/);
	if (load) return named(load[1]) ? { skill: load[1] } : undefined;
	const resource = normal.match(/(?:^|\/)skills\/([^/]+)\/(.+)$/);
	if (resource && named(resource[1]) && !resource[2].endsWith("/")) return { skill: resource[1], resource: resource[2] };
	return undefined;
}

/**
 * The skill a shell command prints when the whole command is one read of one SKILL.md
 * (`cat`, `head`, `bat`, `less`, `sed -n '…p'`, optionally after `cd <dir> &&`). Searches, edits, globs and
 * bulk listings mention SKILL.md without loading it, so they do not count.
 */
const PRINT = /^(?:cd\s+\S+\s*&&\s*)?(?:cat|bat|less|head(?:\s+-n)?(?:\s+-?\d+)?|sed\s+-n\s+'[\d,$]*p')\s+['"]?([^\s'";|&*?$]+)\/SKILL\.md['"]?\s*$/;

export function skillsFromCommand(command: unknown): string[] {
	if (typeof command !== "string" || !command.includes("SKILL.md")) return [];
	const m = command.trim().match(PRINT);
	const name = m?.[1].split("/").at(-1);
	return name && /^[A-Za-z0-9][\w.-]*$/.test(name) ? [name] : [];
}

/** Skill names in `<skill name="x" ...>` blocks (a `/skill:` expansion or a declared-skills message). */
export function skillsFromBlocks(text: unknown): string[] {
	if (typeof text !== "string" || !text.includes("<skill name=")) return [];
	return [...text.matchAll(/<skill name="([^"]+)"/g)].map((m) => m[1]);
}

/** Names in the `<available_skills>` section of pi's system prompt. */
export function skillsFromCatalog(text: unknown): string[] {
	if (typeof text !== "string") return [];
	return [...text.matchAll(/<skill>\s*<name>([^<]+)<\/name>/g)].map((m) => m[1].trim());
}
