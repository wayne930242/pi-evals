import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Node strips types in checkouts but forbids it under node_modules. npm ships dist there.
const installed = new URL(import.meta.url).pathname.split('/').includes('node_modules');
const load = name => import(installed ? `../dist/${name}.js` : `../src/${name}.ts`);
const [{ layout }, { loadIndex }, { recentDays, packageCounts }, { safeName }] = await Promise.all(
	['paths', 'build', 'trends', 'schema'].map(load),
);
export { packageCounts, safeName };

export function run(usage, fn) {
	try {
		const args = process.argv.slice(2);
		if (!args.length || args.some(x => !x || safeName(x) !== x)) throw new Error(usage);
		const text = fn(args).join('\n') + '\n';
		if (Buffer.byteLength(text) > 2000) throw new Error('Result exceeds the output limit.');
		process.stdout.write(text);
	} catch (error) {
		// Never echo unknown arguments, local paths or JSON parse excerpts.
		console.error(error instanceof QueryError ? error.message : `Cannot read query. ${usage}`);
		process.exitCode = 1;
	}
}
export class QueryError extends Error {}
export function daily(project) {
	const index = loadIndex(layout());
	if (!index) throw new QueryError('No index. Run /evals extract first.');
	return { rows: recentDays(index, project), index, header: `Extract ${index.lastExtract ?? 'never'}; complete UTC dates${project ? `; project ${project}` : '; all projects'}` };
}
export function report() {
	const range = process.env.PI_EVALS_REPORT_RANGE ?? '30';
	const files = new Map([['14', 'model-14d.json'], ['30', 'model.json'], ['90', 'model-90d.json'], ['all', 'model-all.json'], ['custom', 'model-custom.json']]);
	if (!files.has(range)) throw new QueryError('Choose PI_EVALS_REPORT_RANGE=14, 30, 90, all or custom.');
	try { return JSON.parse(readFileSync(join(layout().reports, files.get(range)), 'utf8')); }
	catch { throw new QueryError('No readable report model. Run /evals report first.'); }
}
