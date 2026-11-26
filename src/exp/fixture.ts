/**
 * Fixtures: a task's starting tree built once (archive of the base commit or the task's own directory, then setup.sh),
 * committed as one fresh commit with a fixed author and date. No history, remote, reflog or later commits, so the
 * reference solution cannot leak through git. Trials get an APFS clone of it.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Suite, Task } from "./task.ts";

const IDENTITY = {
	GIT_AUTHOR_NAME: "fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.invalid",
	GIT_COMMITTER_NAME: "fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.invalid",
	GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
	GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};
// The user's global and system git config (hooks, signing, templates) stays out of fixture builds.
export const GIT_ENV = { ...process.env, ...IDENTITY, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV, maxBuffer: 1 << 28 }).trim();

function extract(repo: string, sha: string, into: string) {
	execFileSync("sh", ["-c", 'git -C "$1" archive "$2" | tar -x -C "$3"', "sh", repo, sha, into], { env: GIT_ENV, stdio: ["ignore", "ignore", "inherit"] });
}

export function fixtureName(task: Task): string {
	const f = task.fixture;
	return f.dir ? `${task.id}@dir` : `${task.id}@${f.base?.slice(0, 12)}${f.review ? `-${f.review.slice(0, 12)}` : ""}`;
}

/** Build (or reuse) the task's fixture under `root`; returns its directory. */
export function buildFixture(suite: Suite, task: Task, root: string, options: { rebuild?: boolean; log?: (line: string) => void } = {}): string {
	const name = fixtureName(task);
	const dir = join(root, name);
	const ok = join(root, `${name}.ok`);
	if (existsSync(ok) && existsSync(dir) && !options.rebuild) return dir;
	rmSync(dir, { recursive: true, force: true });
	rmSync(ok, { force: true });
	const tmp = join(root, `${name}.building-${process.pid}`);
	rmSync(tmp, { recursive: true, force: true });
	mkdirSync(tmp, { recursive: true });
	const f = task.fixture;
	if (f.dir) cpSync(join(task.dir, f.dir), tmp, { recursive: true });
	else extract(f.repo as string, f.base as string, tmp);
	const setup = join(task.dir, "setup.sh");
	if (existsSync(setup)) {
		options.log?.(`${task.id}: setup.sh`);
		execFileSync("bash", [setup], { cwd: tmp, env: { ...process.env, TASK_DIR: task.dir, SUITE_DIR: suite.dir }, stdio: ["ignore", "inherit", "inherit"] });
	}
	git(tmp, "init", "-q", "-b", "main");
	git(tmp, "config", "user.name", "agent");
	git(tmp, "config", "user.email", "agent@example.invalid");
	git(tmp, "add", "-A");
	git(tmp, "commit", "-q", "--allow-empty", "-m", "fixture");
	if (f.review) {
		git(tmp, "rm", "-rq", "--cached", ".");
		for (const file of git(tmp, "ls-tree", "-r", "--name-only", "HEAD").split("\n").filter(Boolean)) rmSync(join(tmp, file), { force: true });
		extract(f.repo as string, f.review, tmp);
		git(tmp, "add", "-A");
		git(tmp, "commit", "-q", "--allow-empty", "-m", "change under review");
	}
	renameSync(tmp, dir);
	writeFileSync(ok, `${new Date().toISOString()}\n`);
	return dir;
}

/** Copy-on-write clone of a fixture (APFS clonefile on macOS, reflink where the file system has it). */
export function cloneTree(from: string, to: string) {
	mkdirSync(join(to, ".."), { recursive: true });
	if (process.platform === "darwin") execFileSync("cp", ["-cR", from, to]);
	else execFileSync("cp", ["-a", "--reflink=auto", from, to]);
}
