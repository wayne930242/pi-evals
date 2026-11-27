/**
 * The blind UI review (`exp label <run> --ui`): one Markdown page per run with, for each screenshot task, the issue
 * text and pictures, the gate's base and reference shots, and every trial's shot under a random token in a seeded
 * order. Nothing on the page, in a file name or in alt text names the arm. The boss picks the shots that look right in
 * one `review` block; `--answer` turns that into `ui_outcome` label rows, and `uiSummary` feeds `exp show`.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { appendLabel, type LabelRow, readLabels, type Verdict } from "../labels.ts";
import { gateShotsDir, SHOT } from "./artifacts.ts";
import { fixtureName } from "./fixture.ts";
import { sessionIdOf, shuffle, UI_OUTCOME } from "./labels.ts";
import type { RunMeta } from "./run.ts";
import { type Delta, pairedBootstrap } from "./stats.ts";
import { latestRecords } from "./summary.ts";
import type { Suite } from "./task.ts";
import { type TrialRecord, trialDirOf } from "./trial.ts";

export interface UiItem {
	/** `<taskNo>-<letter>`, the name the boss answers with. */
	name: string;
	task: string;
	arm: string;
	n: number;
	sessionId: string;
	image?: string;
}

export const PICK = "畫面做對了";
export const SHOT_FAILED = "畫面產生失敗";
const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
const ISSUE_LINES = 25;

/** A random-looking token from the seeded generator: nothing about the trial goes into it. */
function tokens(seed: number) {
	let a = (seed ^ 0x9e3779b9) >>> 0;
	return () => {
		let s = "";
		for (let i = 0; i < 3; i++) {
			a = (Math.imul(a ^ (a >>> 15), 1 | a) + 0x6d2b79f5) >>> 0;
			s += a.toString(16).padStart(8, "0");
		}
		return s.slice(0, 20);
	};
}

const quote = (s: string) => JSON.stringify(s);

/** The issue's first lines as a quote, with Markdown images dropped (their files are shown separately). */
function issueText(prompt: string): string {
	const lines = prompt.replace(/!\[[^\]]*\]\([^)]*\)/g, "（附圖見下）").replace(/<img[^>]*>/gi, "（附圖見下）").split("\n").slice(0, ISSUE_LINES);
	return lines.map((l) => `> ${l}`.trimEnd()).join("\n");
}

/** Write `<runDir>/ui-review/{index.md, img/, ui-review.json}`; returns the page and the items. */
export function writeUiReview(runDir: string, meta: RunMeta, records: TrialRecord[], options: { suite: Suite; fixturesRoot: string; seed?: number; showReference?: boolean }): { page: string; items: UiItem[] } {
	const seed = options.seed ?? 20261127;
	const token = tokens(seed);
	const dir = join(runDir, "ui-review");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(join(dir, "img"), { recursive: true });
	const put = (file: string) => {
		const name = `${token()}${extname(file).toLowerCase() || ".png"}`;
		copyFileSync(file, join(dir, "img", name));
		return `img/${name}`;
	};
	const arms = Object.keys(meta.arms);
	const trials = latestRecords(records).filter((r) => r.valid && arms.includes(r.arm));
	const tasks = shuffle(options.suite.tasks.filter((t) => t.screenshot && trials.some((r) => r.task === t.id)), seed);
	const sections: string[] = [];
	const items: UiItem[] = [];
	const reviewItems: string[] = [];
	tasks.forEach((task, ti) => {
		const no = ti + 1;
		const parts = [`## 第 ${no} 題：${task.id}`, "", "**問題描述（前 25 行）**", "", issueText(task.prompt), ""];
		const issueDir = join(options.fixturesRoot, fixtureName(task), ".issue");
		const pictures = existsSync(issueDir) ? readdirSync(issueDir).filter((f) => IMAGE.test(f)).sort() : [];
		pictures.forEach((f, i) => parts.push(`![問題附圖 ${i + 1}](${put(join(issueDir, f))})`, ""));
		const gateShots = gateShotsDir(options.fixturesRoot, task.id);
		const base = join(gateShots, "base.png");
		const reference = join(gateShots, "reference.png");
		parts.push("**改之前**", "", existsSync(base) ? `![改之前](${put(base)})` : "（沒有改之前的畫面）", "");
		if (options.showReference !== false) parts.push("**參考答案**", "", existsSync(reference) ? `![參考答案](${put(reference)})` : "（沒有參考答案的畫面）", "");
		const mine = shuffle(trials.filter((r) => r.task === task.id), seed + no);
		parts.push(`這題有 ${mine.length} 張結果，在最後的勾選區編號為 ${mine.map((_, i) => `${no}-${String.fromCharCode(65 + i)}`).join("、")}。`, "");
		sections.push(parts.join("\n"));
		mine.forEach((r, i) => {
			const name = `${no}-${String.fromCharCode(65 + i)}`;
			const shot = join(trialDirOf(runDir, r.task, r.arm, r.n), "artifacts", SHOT);
			const image = r.screenshot?.ok && existsSync(shot) ? put(shot) : undefined;
			items.push({ name, task: r.task, arm: r.arm, n: r.n, sessionId: r.session && existsSync(r.session) ? sessionIdOf(r.session) : `${r.task}/${r.n}`, ...(image ? { image } : {}) });
			reviewItems.push([`  - name: ${quote(name)}`, `    label: ${quote(`第 ${no} 題`)}`, image ? `    image: ${image}` : `    body: ${quote(SHOT_FAILED)}`].join("\n"));
		});
	});
	writeFileSync(join(dir, "ui-review.json"), `${JSON.stringify({ run: meta.id, seed, items }, null, 2)}\n`);
	const page = join(dir, "index.md");
	writeFileSync(
		page,
		[
			`# 畫面檢查：${meta.id}`,
			"",
			`共 ${tasks.length} 題、${items.length} 張結果。每題先看問題描述、改之前的畫面${options.showReference !== false ? "和參考答案" : ""}，再到最後的勾選區，把你覺得「畫面做對了」的結果勾起來；沒勾的算做錯。看不出來的，在那張留言寫「看不出」或用「?」開頭。結果的順序已打亂，也不標示是哪一組。`,
			"",
			...sections,
			"## 勾選區",
			"",
			"```review",
			`title: ${quote(`${meta.id} 畫面檢查`)}`,
			"submit: 送出",
			`pick: ${quote(PICK)}`,
			"pickMode: multi",
			"columns: 2",
			"items:",
			...reviewItems,
			"```",
			"",
		].join("\n"),
	);
	return { page, items };
}

const NAME = /(\d+-[A-Z]+)/g;

/**
 * Parse pi-better-show's review answer (`Picked: <name> (<label>)`, `- <name> (<label>): <comment>`, `No feedback on:
 * …`) into one `ui_outcome` row per item: picked is pass, not picked is fail, and a comment starting with `?` or
 * containing 看不出 is unclear. Returns no rows when the text is not a review answer.
 */
export function parseUiAnswer(answer: string, names: string[]): Map<string, { label: Verdict; note?: string }> {
	const picked = new Set<string>();
	const comments = new Map<string, string>();
	let recognized = false;
	let current: string | undefined;
	for (const line of answer.split("\n")) {
		const pick = /^Picked(?: \([^)]*\))?: (.+)$/.exec(line);
		const item = /^- (\d+-[A-Z]+)(?: \([^)]*\))?: ?(.*)$/.exec(line);
		if (pick) {
			recognized = true;
			current = undefined;
			for (const m of pick[1].matchAll(NAME)) picked.add(m[1]);
		} else if (item) {
			recognized = true;
			current = item[1];
			comments.set(current, item[2]);
		} else if (/^No feedback on:/.test(line) || /^User reviewed/.test(line)) {
			recognized = true;
			current = undefined;
		} else if (/^Other comments:/.test(line)) current = undefined;
		else if (current && /^ {2}/.test(line)) comments.set(current, `${comments.get(current)}\n${line.slice(2)}`);
	}
	const out = new Map<string, { label: Verdict; note?: string }>();
	if (!recognized) return out;
	for (const name of names) {
		const note = comments.get(name)?.trim();
		const unclear = note !== undefined && (note.startsWith("?") || note.startsWith("？") || note.includes("看不出"));
		out.set(name, { label: unclear ? "unclear" : picked.has(name) ? "pass" : "fail", ...(note ? { note: note.slice(0, 500) } : {}) });
	}
	return out;
}

/** Store the boss's review answer as `ui_outcome` rows (`source: "experiment"`, item `task/arm/n`). */
export function applyUiAnswer(runDir: string, meta: RunMeta, answer: string, labelsFile: string, at = new Date().toISOString()): LabelRow[] {
	const { items } = JSON.parse(readFileSync(join(runDir, "ui-review", "ui-review.json"), "utf8")) as { items: UiItem[] };
	const verdicts = parseUiAnswer(answer, items.map((i) => i.name));
	const rows: LabelRow[] = [];
	for (const item of items) {
		const v = verdicts.get(item.name);
		if (!v) continue;
		rows.push({ session_id: item.sessionId, evaluation_name: UI_OUTCOME, label: v.label, at, annotator: "human", source: "experiment", item: `${item.task}/${item.arm}/${item.n}`, project: `exp:${meta.id}`, ...(v.note ? { note: v.note } : {}) });
	}
	for (const row of rows) appendLabel(labelsFile, row);
	return rows;
}

export interface UiArm {
	arm: string;
	/** Task-averaged share of labelled trials the boss judged right (unclear left out). */
	correct?: number;
	labelled: number;
	shotsOk: number;
	shots: number;
}
export interface UiSummary {
	arms: UiArm[];
	delta?: Delta;
	agree: number;
	disagree: string[];
	unclear: number;
}

/** The boss's UI verdicts for a run, per arm, B − A, and agreement with the verifier; undefined without screenshots. */
export function uiSummary(meta: RunMeta, records: TrialRecord[], labelsFile: string, options: { resamples?: number; seed?: number } = {}): UiSummary | undefined {
	const arms = Object.keys(meta.arms);
	const trials = latestRecords(records).filter((r) => r.valid);
	if (!trials.some((r) => r.screenshot)) return undefined;
	const latest = new Map<string, Verdict>();
	if (existsSync(labelsFile)) for (const row of readLabels(labelsFile)) if (row.source === "experiment" && row.project === `exp:${meta.id}` && row.evaluation_name === UI_OUTCOME && row.item) latest.set(row.item, row.label);
	const value = (r: TrialRecord): number | undefined => {
		const l = latest.get(`${r.task}/${r.arm}/${r.n}`);
		return l === "pass" ? 1 : l === "fail" ? 0 : undefined;
	};
	const tasks = [...new Set(trials.map((r) => r.task))].sort();
	const values = (task: string, arm: string) => trials.filter((r) => r.task === task && r.arm === arm).map(value).filter((v): v is number => v !== undefined);
	const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
	const out: UiSummary = {
		arms: arms.map((arm) => {
			const mine = trials.filter((r) => r.arm === arm && r.screenshot);
			const perTask = tasks.map((t) => values(t, arm)).filter((xs) => xs.length).map(mean);
			return { arm, ...(perTask.length ? { correct: mean(perTask) } : {}), labelled: mine.filter((r) => value(r) !== undefined).length, shotsOk: mine.filter((r) => r.screenshot?.ok).length, shots: mine.length };
		}),
		agree: 0,
		disagree: [],
		unclear: 0,
	};
	if (arms.length >= 2) {
		const d = pairedBootstrap(tasks.map((t) => ({ a: values(t, arms[0]), b: values(t, arms[1]) })), mean, options);
		if (d.tasks) out.delta = d;
	}
	for (const r of trials) {
		const l = latest.get(`${r.task}/${r.arm}/${r.n}`);
		if (l === "unclear") out.unclear++;
		else if (l) {
			if ((l === "pass") === r.outcome) out.agree++;
			else out.disagree.push(`${r.task}/${r.arm}/${r.n}`);
		}
	}
	return out;
}
