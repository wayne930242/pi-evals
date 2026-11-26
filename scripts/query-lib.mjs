import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
// Node strips types in checkouts but forbids it under node_modules. npm ships dist there.
const installed = new URL(import.meta.url).pathname.split('/').includes('node_modules');
const load = name => import(installed ? `../dist/${name}.js` : `../src/${name}.ts`);
const [{ layout }, { loadIndex }, { recentDays, packageCounts }, { safeName }, analysis, shape] = await Promise.all(
	['paths', 'build', 'trends', 'schema', 'analysis', 'shape'].map(load),
);
export { analysis, packageCounts, safeName, shape, layout };

/** Bytes a script prints before it writes the whole output to a file under `<state>/runs` and prints the start and the path. */
const max = () => Number(process.env.PI_EVALS_SCRIPT_MAX) > 0 ? Number(process.env.PI_EVALS_SCRIPT_MAX) : 2000;

function emit(lines) {
	const text = lines.join('\n') + '\n';
	if (Buffer.byteLength(text) <= max()) return process.stdout.write(text);
	const dir = join(layout().state, 'runs');
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${basename(process.argv[1], '.mjs')}-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
	writeFileSync(file, text);
	const tail = `… ${lines.length} lines; full output: ${file}\n`;
	let head = '';
	for (const line of lines) {
		if (Buffer.byteLength(head + line + '\n' + tail) > max()) break;
		head += line + '\n';
	}
	process.stdout.write(head + tail);
}

/** `fn(args)` returns lines, or `{ lines, status }`; it may be async. */
export async function run(usage, fn) {
	try {
		const args = process.argv.slice(2);
		if (!args.length && fn.length && !fn.noArgs || args.some(x => !x || safeName(x) !== x)) throw new QueryError(usage);
		const out = await fn(args);
		const { lines, status } = Array.isArray(out) ? { lines: out, status: 0 } : out;
		emit(lines);
		process.exitCode = status ?? 0;
	} catch (error) {
		// Never echo unknown arguments, local paths or JSON parse excerpts.
		console.error(error instanceof QueryError || error instanceof analysis.AnalysisError ? error.message : `Cannot read query. ${usage}`);
		process.exitCode = 1;
	}
}
export class QueryError extends Error {}
/** `--name value` from args; the rest positional. */
export function flags(args, names) {
	const out = { rest: [] };
	for (let i = 0; i < args.length; i++) {
		if (names.includes(args[i])) out[args[i].slice(2)] = args[++i];
		else out.rest.push(args[i]);
	}
	return out;
}
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
