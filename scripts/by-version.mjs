import { analysis, flags, layout, QueryError, run } from './query-lib.mjs';

// A detector's pass rate per package version at session start.
const usage = 'node by-version.mjs DETECTOR [--pkg PACKAGE]';
run(usage, args => {
	const f = flags(args, ['--pkg']);
	if (f.rest.length !== 1) throw new QueryError(usage);
	return analysis.byVersion(layout(), f.rest[0], f.pkg);
});
