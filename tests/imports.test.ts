import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// Pi reloads extension TypeScript on /reload, but Node caches native .js/.mjs modules for the
// life of the process. A relative JavaScript import would keep an old version after an upgrade.
test("extension code imports relative modules only as .ts", () => {
	for (const dir of ["src", "src/extract", "src/exp"]) {
		for (const name of readdirSync(join(root, dir)).filter((file) => file.endsWith(".ts"))) {
			const source = readFileSync(join(root, dir, name), "utf8");
			for (const [, specifier] of source.matchAll(/from\s+["'](\.[^"']*)["']/g)) {
				assert.match(specifier ?? "", /\.ts$/, `${dir}/${name} imports ${specifier}`);
			}
		}
	}
});

// The experiment runner is CLI-only: live pi sessions must not load it.
test("the extension entry never reaches src/exp", () => {
	const seen = new Set<string>();
	const visit = (file: string) => {
		if (seen.has(file)) return;
		seen.add(file);
		assert.ok(!file.includes(`${join("src", "exp")}/`), `extension reaches ${file}`);
		const source = readFileSync(file, "utf8");
		for (const [, specifier] of source.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']*)["']/g)) visit(resolve(dirname(file), specifier ?? ""));
	};
	visit(join(root, "src", "index.ts"));
	assert.ok(seen.size > 5);
});
