/**
 * Trial statistics: unbiased pass@1, pass^k and pass@k from c passes in n trials, and a paired cluster bootstrap over
 * tasks for the difference between two arms (tasks resampled, then trials resampled within each task and arm).
 */

function choose(n: number, k: number): number {
	if (k < 0 || k > n) return 0;
	let r = 1;
	for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
	return r;
}

export const passAt1 = (c: number, n: number) => c / n;

/** All k of k fresh trials pass: C(c,k)/C(n,k). */
export function passHatK(c: number, n: number, k: number): number {
	if (k > n) throw new Error(`pass^k needs k > n trials: k ${k} > n ${n}`);
	return choose(c, k) / choose(n, k);
}

/** At least one of k fresh trials passes: 1 − C(n−c,k)/C(n,k). */
export function passAtK(c: number, n: number, k: number): number {
	if (k > n) throw new Error(`pass@k needs k > n trials: k ${k} > n ${n}`);
	return 1 - choose(n - c, k) / choose(n, k);
}

/** Mean of the defined values; undefined when none is defined (a metric that does not apply to the task). */
export function taskRate(values: (number | undefined)[]): number | undefined {
	const defined = values.filter((v): v is number => typeof v === "number");
	return defined.length ? defined.reduce((s, v) => s + v, 0) / defined.length : undefined;
}

/** mulberry32: a small seeded PRNG so a summary is reproducible. */
function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export interface PairedTask {
	a: number[];
	b: number[];
}
export interface Delta {
	/** B − A, the mean over paired tasks of the per-task statistic difference. */
	delta: number;
	lo: number;
	hi: number;
	tasks: number;
}

/**
 * Paired cluster bootstrap: the statistic is computed per task and arm from that task's trial values, the delta is the
 * mean over tasks of B − A. Tasks with no trial in either arm are left out. 95% percentile interval.
 */
export function pairedBootstrap(tasks: PairedTask[], stat: (trials: number[]) => number, options: { resamples?: number; seed?: number } = {}): Delta {
	const paired = tasks.filter((t) => t.a.length && t.b.length);
	if (!paired.length) return { delta: Number.NaN, lo: Number.NaN, hi: Number.NaN, tasks: 0 };
	const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
	const delta = mean(paired.map((t) => stat(t.b) - stat(t.a)));
	const random = rng(options.seed ?? 20261126);
	const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)];
	const resample = (xs: number[]) => xs.map(() => pick(xs));
	const draws: number[] = [];
	for (let i = 0; i < (options.resamples ?? 10_000); i++) {
		const sample = paired.map(() => pick(paired));
		draws.push(mean(sample.map((t) => stat(resample(t.b)) - stat(resample(t.a)))));
	}
	draws.sort((x, y) => x - y);
	const at = (q: number) => draws[Math.min(draws.length - 1, Math.max(0, Math.floor(q * draws.length)))];
	return { delta, lo: at(0.025), hi: at(0.975), tasks: paired.length };
}
