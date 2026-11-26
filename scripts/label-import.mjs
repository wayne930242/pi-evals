import { analysis, flags, layout, QueryError, run } from './query-lib.mjs';

// Submitted label-form answers into labels.jsonl, as after-the-fact human labels.
const usage = 'node label-import.mjs ANSWER_FILE [--sample SAMPLE_FILE]';
run(usage, args => {
	const f = flags(args, ['--sample']);
	if (f.rest.length !== 1) throw new QueryError(usage);
	return analysis.labelImport(layout(), f.rest[0], f.sample);
});
