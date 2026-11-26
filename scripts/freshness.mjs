import { analysis, layout, run } from './query-lib.mjs';

// Is the index current? Exit 1 when summaries come from more than one extractor version.
const usage = 'node freshness.mjs';
const check = args => { if (args.length) throw new Error(usage); return analysis.freshness(layout()); };
check.noArgs = true;
run(usage, check);
