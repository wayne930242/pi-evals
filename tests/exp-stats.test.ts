import assert from "node:assert/strict";
import { test } from "node:test";
import { pairedBootstrap, passAt1, passAtK, passHatK, taskRate } from "../src/exp/stats.ts";

test("pass@1, pass^k and pass@k follow the unbiased estimators", () => {
	assert.equal(passAt1(2, 3), 2 / 3);
	assert.equal(passHatK(3, 3, 3), 1);
	assert.equal(passHatK(2, 3, 3), 0);
	assert.equal(passHatK(3, 5, 3), 1 / 10);
	assert.equal(passAtK(0, 3, 3), 0);
	assert.equal(passAtK(1, 3, 3), 1);
	assert.equal(passAtK(1, 5, 3), 1 - 4 / 10);
	assert.throws(() => passHatK(1, 2, 3), /k > n/);
});

test("taskRate averages the defined values and is undefined when none is defined", () => {
	assert.equal(taskRate([1, 0, undefined, 1]), 2 / 3);
	assert.equal(taskRate([undefined, undefined]), undefined);
});

test("paired bootstrap: identical arms give a zero delta with a CI around 0", () => {
	const tasks = Array.from({ length: 5 }, (_, i) => ({ a: [i % 2, 1, 0], b: [i % 2, 1, 0] }));
	const r = pairedBootstrap(tasks, (xs) => xs.reduce((s, x) => s + x, 0) / xs.length, { resamples: 2000, seed: 7 });
	assert.equal(r.delta, 0);
	assert.equal(r.tasks, 5);
	assert.ok(r.lo <= 0 && r.hi >= 0, `${r.lo}..${r.hi}`);
});

test("paired bootstrap: B always better gives a CI above 0, deterministic for a seed", () => {
	const tasks = Array.from({ length: 6 }, () => ({ a: [0, 0, 1], b: [1, 1, 1] }));
	const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
	const r1 = pairedBootstrap(tasks, mean, { resamples: 2000, seed: 1 });
	const r2 = pairedBootstrap(tasks, mean, { resamples: 2000, seed: 1 });
	assert.deepEqual(r1, r2);
	assert.ok(Math.abs(r1.delta - 2 / 3) < 1e-9);
	assert.ok(r1.lo > 0, `lo ${r1.lo}`);
	assert.ok(r1.hi <= 1);
});

test("paired bootstrap: tasks missing either arm are left out of the pairing", () => {
	const r = pairedBootstrap([{ a: [1], b: [1] }, { a: [], b: [1] }], (xs) => xs[0], { resamples: 100, seed: 3 });
	assert.equal(r.tasks, 1);
});
