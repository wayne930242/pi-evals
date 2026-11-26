import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("the pi-evals bin uses npm's canonical relative path and ships a Node CLI", () => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(pkg.bin["pi-evals"], "dist/cli.js", "a leading ./ triggers npm's publish correction");
	assert.ok(pkg.files.includes("dist"));
	assert.ok(readFileSync(new URL(`../${pkg.bin["pi-evals"]}`, import.meta.url), "utf8").startsWith("#!/usr/bin/env node\n"));
});
