import { packageCounts } from '../dist/trends.js';
import { daily, QueryError, run } from './query-lib.mjs';

const usage = 'node package-errors.mjs PACKAGE [PROJECT]';
run(usage, args => {
	if (args.length > 2) throw new QueryError(usage);
	const [pkg, project] = args, { rows, index, header } = daily(project);
	const counts = rows.map(({ day, agg }) => ({ day, count: packageCounts(index, agg).get(pkg) }));
	if (!counts.some(x => x.count)) throw new QueryError('No calls for this package in the selected days and project.');
	return [header, `${pkg}: tool errors/calls`, ...counts.map(({ day, count }) => `${day} ${count?.errors ?? 0}/${count?.calls ?? 0} ${count?.calls ? (100 * count.errors / count.calls).toFixed(1) + '%' : 'n/a'}`)];
});
