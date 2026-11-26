import { analysis, flags, layout, QueryError, run } from './query-lib.mjs';

// Where the code and the user's labels disagree on one rule, session by session.
const usage = 'node disagree.mjs RULE [--range DAYS]';
run(usage, args => {
	const f = flags(args, ['--range']);
	if (f.rest.length !== 1 || (f.range !== undefined && !/^\d+$/.test(f.range))) throw new QueryError(usage);
	return analysis.disagree(layout(), f.rest[0], f.range === undefined ? undefined : Number(f.range));
});
