/**
 * Change alerts: after a setup change (a pin, a rules, skill, role or routing commit, a mark), compare each process
 * detector's pass rate in the sessions before and after it, from the extracted index alone, and say once when one
 * clearly dropped. No model call and no extract: it reads `index/sessions.json` and `changes.jsonl`.
 *
 * The drop rule: both windows (`impactWindowDays` before and after the change, by session start, the same split as the
 * changes view) hold at least `alertMinSessions` sessions the detector applies to, the after pass rate is at least
 * ten percentage points lower, and a one-sided pooled two-proportion z-test gives z >= 3 (p ~ 0.0013). The scan tests
 * many change points, so the bar is higher than the usual 1.96. Change points closer than one window for the same
 * detector fold into the one with the largest z (or into one already shown), so one drop warns once.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionRow } from "./aggregate.ts";
import type { Change } from "./changes.ts";
import { DETECTORS, ERA_START } from "./detectors.ts";
import { DETECTOR_META } from "./meta.ts";
import { STALE_HOURS } from "./model.ts";

type Env = Record<string, string | undefined>;
export type Locale = "en" | "zh-TW";

export const DROP_POINTS = 0.1;
export const DROP_Z = 3;
/** Change points older than this (days before the last extract) are not scanned. */
export const LOOKBACK_DAYS = 14;
const DAY = 86_400_000;

export interface Side {
	pass: number;
	n: number;
}

/** The drop rule on one detector's before and after counts. */
export function dropTest(before: Side, after: Side): { dropped: boolean; z: number; drop: number } {
	if (!before.n || !after.n) return { dropped: false, z: 0, drop: 0 };
	const p1 = before.pass / before.n, p2 = after.pass / after.n, drop = p1 - p2;
	const pooled = (before.pass + after.pass) / (before.n + after.n);
	const se = Math.sqrt(pooled * (1 - pooled) * (1 / before.n + 1 / after.n));
	const z = se > 0 ? drop / se : 0;
	// Compare the counts, not rounded rates, against the ten-point bar.
	const big = 10 * (before.pass * after.n - after.pass * before.n) >= before.n * after.n;
	return { dropped: big && z >= DROP_Z, z, drop };
}

export interface ChangeRef {
	kind: Change["kind"];
	subject: string;
	package?: string;
	from?: string;
	to?: string;
	sha?: string;
}
export interface Alert {
	/** `<change point time>|<detector>`: one warning per change point and detector. */
	key: string;
	at: string;
	/** The changes at this point, the one that names it first. */
	changes: ChangeRef[];
	detector: string;
	before: Side;
	after: Side;
	z: number;
	windowDays: number;
	/** Other change points inside the two windows. */
	nearby: number;
}
export interface Shown extends Alert {
	shownAt: string;
}

const RANK: Record<string, number> = { "pi-anchorloop": 0, "pi-straw-boss": 1 };
const KIND_RANK: Record<string, number> = { pin: 2, rule: 3, skill: 4, "agent-role": 5, "model-routing": 6, manual: 7 };
const rank = (c: ChangeRef) => (c.kind === "pin" && c.package ? (RANK[c.package] ?? KIND_RANK.pin) : (KIND_RANK[c.kind] ?? 8));

/** Changes at the same instant (one commit, one mark) are one point. */
function changePoints(changes: Change[]): { at: string; changes: ChangeRef[] }[] {
	const by = new Map<string, ChangeRef[]>();
	for (const c of changes) {
		const list = by.get(c.at) ?? [];
		list.push({ kind: c.kind, subject: c.subject, package: c.package, from: c.from, to: c.to, sha: c.sha });
		by.set(c.at, list);
	}
	return [...by].sort(([a], [b]) => a.localeCompare(b)).map(([at, list]) => ({ at, changes: list.sort((a, b) => rank(a) - rank(b)) }));
}

/** Index of the first row starting at or after `t` (rows sorted by start). */
function lowerBound(times: number[], t: number): number {
	let lo = 0, hi = times.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (times[mid] < t) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

function counts(rows: SessionRow[], from: number, to: number): Record<string, Side> {
	const out: Record<string, Side> = {};
	for (let i = from; i < to; i++) {
		for (const [name, v] of Object.entries(rows[i].ev)) {
			const side = (out[name] ??= { pass: 0, n: 0 });
			side.pass += v;
			side.n += 1;
		}
	}
	return out;
}

export interface Found {
	/** Drops not shown yet, newest change first. */
	pending: Alert[];
	shown: Shown[];
	/** Clear-looking drops with too few sessions after the change so far. */
	waiting: Alert[];
}

export function findAlerts(input: { rows: SessionRow[]; changes: Change[]; lastExtract: string; windowDays: number; minSessions: number; shown?: Shown[] }): Found {
	const W = input.windowDays * DAY, min = Math.max(1, input.minSessions);
	const rows = input.rows.filter((r) => Object.keys(r.ev).length).sort((a, b) => a.s.localeCompare(b.s));
	const times = rows.map((r) => Date.parse(r.s));
	const cutoff = Math.max(Date.parse(ERA_START), Date.parse(input.lastExtract) - LOOKBACK_DAYS * DAY);
	const points = changePoints(input.changes);
	const pointTimes = points.map((p) => Date.parse(p.at));
	const candidates: Alert[] = [], waiting: Alert[] = [];
	points.forEach((p, idx) => {
		const at = pointTimes[idx];
		if (at < cutoff || at > Date.parse(input.lastExtract)) return;
		const b = counts(rows, lowerBound(times, at - W), lowerBound(times, at));
		const a = counts(rows, lowerBound(times, at), lowerBound(times, at + W));
		const nearby = pointTimes.filter((t, j) => j !== idx && t >= at - W && t < at + W).length;
		for (const detector of DETECTORS) {
			const before = b[detector] ?? { pass: 0, n: 0 }, after = a[detector] ?? { pass: 0, n: 0 };
			if (before.n < min) continue;
			const test = dropTest(before, after);
			const alert: Alert = { key: `${p.at}|${detector}`, at: p.at, changes: p.changes, detector, before, after, z: Math.round(test.z * 100) / 100, windowDays: input.windowDays, nearby };
			if (after.n >= min) {
				if (test.dropped) candidates.push(alert);
			} else if (after.n > 0 && 10 * (before.pass * after.n - after.pass * before.n) >= before.n * after.n) waiting.push(alert);
		}
	});
	const shown = input.shown ?? [];
	const accepted = shown.map((s) => ({ detector: s.detector, t: Date.parse(s.at) }));
	const shownKeys = new Set(shown.map((s) => s.key));
	const pending: Alert[] = [];
	for (const c of candidates.sort((x, y) => y.z - x.z || y.at.localeCompare(x.at))) {
		if (shownKeys.has(c.key)) continue;
		const t = Date.parse(c.at);
		if (accepted.some((x) => x.detector === c.detector && Math.abs(x.t - t) < W)) continue;
		accepted.push({ detector: c.detector, t });
		pending.push(c);
	}
	pending.sort((x, y) => y.at.localeCompare(x.at) || y.z - x.z);
	const pendingDetectors = new Set([...pending, ...shown].map((x) => x.detector));
	// The newest point per detector that looks lower but has too few sessions after it yet.
	const newest = new Map<string, Alert>();
	for (const w of waiting) if (!pendingDetectors.has(w.detector) && (newest.get(w.detector)?.at ?? "") < w.at) newest.set(w.detector, w);
	return { pending, shown, waiting: [...newest.values()].sort((x, y) => y.at.localeCompare(x.at)) };
}

export function readShown(file: string): Shown[] {
	if (!existsSync(file)) return [];
	const out: Shown[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		try {
			const s = JSON.parse(line) as Shown;
			if (typeof s.key === "string" && typeof s.at === "string" && typeof s.detector === "string") out.push(s);
		} catch {}
	}
	return out;
}

/** Records an alert as shown; false when another session recorded it first. */
export function recordShown(file: string, alert: Alert, at: string): boolean {
	if (readShown(file).some((s) => s.key === alert.key)) return false;
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${JSON.stringify({ ...alert, shownAt: at } satisfies Shown)}\n`);
	return true;
}

/** pi has no language setting of its own: pi-evals' `locale` setting, else the environment as a shell reads it. */
export function uiLocale(env: Env, setting?: string): Locale {
	if (setting === "zh-TW" || setting === "en") return setting;
	let set = env.LC_ALL || env.LC_MESSAGES || env.LANG;
	if (!set) {
		try {
			set = Intl.DateTimeFormat().resolvedOptions().locale;
		} catch {}
	}
	return /^zh[_-](tw|hk|mo|hant)/i.test(set ?? "") ? "zh-TW" : "en";
}

const short = (pkg: string) => pkg.replace(/^@[^/]+\//, "").replace(/^pi-/, "");
export function changeName(changes: ChangeRef[], lang: Locale): string {
	const c = changes[0];
	const zh = lang === "zh-TW";
	const sha = c.sha ? ` ${c.sha.slice(0, 7)}` : "";
	const one = c.kind === "pin" && c.package
		? `${short(c.package)} ${c.to ?? (zh ? "（移除）" : "(removed)")}`
		: c.kind === "manual"
		? `“${Array.from(c.subject).slice(0, 40).join("")}”`
		: zh
		? `${({ rule: "規則變更", skill: "skill 變更", "agent-role": "角色變更", "model-routing": "模型路由變更" } as Record<string, string>)[c.kind] ?? "變更"}${sha}`
		: `${({ rule: "rules change", skill: "skill change", "agent-role": "role change", "model-routing": "model routing change" } as Record<string, string>)[c.kind] ?? "change"}${sha}`;
	const more = changes.length - 1;
	return more ? (zh ? `${one}（同時另 ${more} 項）` : `${one} (+${more} at once)`) : one;
}

const pct = (s: Side) => `${Math.round((100 * s.pass) / s.n)}%`;
const label = (detector: string, lang: Locale) => DETECTOR_META[detector]?.label[lang === "zh-TW" ? "zh" : "en"] ?? detector;

/** The one session-start line. `more` is how many other drops are pending. */
export function alertLine(a: Alert, lang: Locale, more: number): string {
	const name = changeName(a.changes, lang);
	if (lang === "zh-TW") {
		const side = a.changes[0].kind === "pin" ? "升版前" : "變更前";
		return `pi-evals：${name} 之後 ${a.after.n} 個工作階段，「${label(a.detector, lang)}」從 ${pct(a.before)} 掉到 ${pct(a.after)}（${side} ${a.before.n} 個）。${more ? `另有 ${more} 項。` : ""}/evals alerts 看細節`;
	}
	return `pi-evals: ${a.after.n} sessions after ${name}, “${label(a.detector, lang)}” fell from ${pct(a.before)} to ${pct(a.after)} (${a.before.n} before). ${more ? `${more} more. ` : ""}/evals alerts for details`;
}

const frac = (s: Side) => `${s.pass}/${s.n} (${s.n ? ((100 * s.pass) / s.n).toFixed(1) : "—"}%)`;
function detailLine(a: Alert, lang: Locale): string {
	const zh = lang === "zh-TW";
	const near = a.nearby ? (zh ? `；兩側窗口內另有 ${a.nearby} 個變更點` : `; ${a.nearby} other change points in the windows`) : "";
	return `${a.at} ${changeName(a.changes, lang)} · ${label(a.detector, lang)} (${a.detector}): ${frac(a.before)} → ${frac(a.after)}, z ${a.z.toFixed(2)}${near}`;
}

export interface AlertState extends Found {
	status: "fresh" | "stale" | "empty" | "off";
	lastExtract?: string;
	ageHours?: number;
	minSessions: number;
	windowDays: number;
}

/** The rule, the freshness, and every pending, shown and waiting alert, for `/evals alerts` and the CLI. */
export function alertsText(state: AlertState, lang: Locale): string {
	const zh = lang === "zh-TW";
	const rule = zh
		? `規則：變更前後各 ${state.windowDays} 天、兩側各至少 ${state.minSessions} 個適用的工作階段，之後的通過率低 10 個百分點以上，且單尾雙比例 z 檢定 z ≥ ${DROP_Z}；同一偵測器相距不到一個窗口的變更點併為一筆。`
		: `rule: ${state.windowDays} days on each side of a change, at least ${state.minSessions} sessions the detector applies to on each side, the after pass rate 10+ points lower, and a one-sided two-proportion z-test z >= ${DROP_Z}; points within one window for the same detector fold into one.`;
	const head = state.status === "empty"
		? (zh ? "pi-evals：還沒有擷取資料；執行 /evals extract。" : "pi-evals: nothing extracted yet; run /evals extract.")
		: state.status === "off"
		? (zh ? "pi-evals：設定已關閉變更警示（changeAlerts: false）。" : "pi-evals: change alerts are off in settings (changeAlerts: false).")
		: state.status === "stale"
		? (zh ? `pi-evals：最後擷取在 ${state.lastExtract}（${state.ageHours} 小時前），開工時不警示；/evals extract 更新後再比。下列為依舊資料的結果。` : `pi-evals: last extract ${state.lastExtract} (${state.ageHours}h ago), so session start stays quiet until /evals extract refreshes it. Below is what the old data says.`)
		: (zh ? `pi-evals：最後擷取 ${state.lastExtract}` : `pi-evals: last extract ${state.lastExtract}`);
	if (state.status === "empty" || state.status === "off") return head;
	const block = (title: string, list: Alert[], line: (a: Alert) => string) => [`${title} (${list.length})`, ...(list.length ? list.map(line) : [zh ? "  無" : "  none"])];
	return [
		head,
		rule,
		...block(zh ? "待提醒" : "pending", state.pending, (a) => `  ${detailLine(a, lang)}`),
		...block(zh ? "已提醒" : "shown", state.shown, (a) => `  ${detailLine(a, lang)}; ${zh ? "提醒於" : "shown"} ${(a as Shown).shownAt}`),
		...block(zh ? `看似下降但之後未滿 ${state.minSessions} 個` : `looks lower, under ${state.minSessions} sessions after so far`, state.waiting.slice(0, 5), (a) => `  ${detailLine(a, lang)}`),
	].join("\n");
}

export interface AlertSources {
	status: string;
	sessionRows: string;
	changes: string;
	alerts: string;
}

/**
 * Reads the extracted store asynchronously and finds the alerts. Stale data (last extract older than STALE_HOURS)
 * is reported as stale: the session start shows nothing then.
 */
export async function loadAlerts(files: AlertSources, settings: { impactWindowDays: number; alertMinSessions: number; changeAlerts: boolean }, now: number, options: { skipStale?: boolean } = {}): Promise<AlertState> {
	const base = { pending: [] as Alert[], shown: [] as Shown[], waiting: [] as Alert[], minSessions: settings.alertMinSessions, windowDays: settings.impactWindowDays };
	if (!settings.changeAlerts) return { ...base, status: "off" };
	let lastExtract: string | undefined;
	try {
		lastExtract = (JSON.parse(await readFile(files.status, "utf8")) as { lastExtract?: string }).lastExtract;
	} catch {}
	if (!lastExtract || !existsSync(files.sessionRows)) return { ...base, status: "empty" };
	const ageHours = Math.round(((now - Date.parse(lastExtract)) / 3_600_000) * 10) / 10;
	const status = ageHours > STALE_HOURS ? "stale" : "fresh";
	if (status === "stale" && options.skipStale) return { ...base, status, lastExtract, ageHours };
	const rows = JSON.parse(await readFile(files.sessionRows, "utf8")) as SessionRow[];
	const changes = existsSync(files.changes)
		? (await readFile(files.changes, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Change)
		: [];
	const found = findAlerts({ rows, changes, lastExtract, windowDays: settings.impactWindowDays, minSessions: settings.alertMinSessions, shown: readShown(files.alerts) });
	return { ...base, ...found, status, lastExtract, ageHours };
}
