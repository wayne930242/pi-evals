import { analysis, flags, layout, QueryError, run } from './query-lib.mjs';

// A stratified sample of sessions to label by hand: ids and metadata only.
const usage = 'node sample.mjs N [--since ISO] [--seed INT]';
run(usage, args => {
	const f = flags(args, ['--since', '--seed']);
	if (f.rest.length !== 1 || !/^\d+$/.test(f.rest[0]) || (f.seed !== undefined && !/^\d+$/.test(f.seed))) throw new QueryError(usage);
	return analysis.sample(layout(), Number(f.rest[0]), { since: f.since, seed: f.seed === undefined ? undefined : Number(f.seed) });
});
