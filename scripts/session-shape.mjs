import { analysis, layout, QueryError, run, shape } from './query-lib.mjs';

// The ordered events the detectors see in one session, without message text.
const usage = 'node session-shape.mjs SESSION_ID';
run(usage, async args => {
	if (args.length !== 1) throw new QueryError(usage);
	return shape.sessionShape(analysis.sessionFile(layout(), args[0]));
});
