import { QueryError, report, run, safeName } from './query-lib.mjs';

const usage = 'node change-impact.mjs UTC_TIMESTAMP_OR_SHA [PACKAGE_OR_KIND]';
run(usage, args => {
	if (args.length > 2) throw new QueryError(usage);
	const [id, which] = args, m = report();
	const hits = m.changes.filter(c => (c.at === id || c.sha === id) && (!which || c.package === which || c.kind === which));
	if (hits.length !== 1) throw new QueryError(hits.length ? 'Multiple entries match; specify a package or change kind.' : 'No such change in the saved report.');
	const { at, impact: i } = hits[0];
	const header = `${at}; extract ${m.freshness.lastExtract ?? 'never'}; ${m.window.project ? safeName(m.window.project) : 'all projects'}`;
	if (!i) return [header, 'No earlier records.'];
	const rows = [header, `${i.window.days} days each side; sessions ${i.before.sessions} → ${i.after.sessions}`, `Too few sessions: ${i.smallSample}; incomplete window: ${i.incomplete}; other changes: ${i.confounded}. A difference does not prove cause.`];
	for (const key of ['tool_error_rate', 'package_error_rate', 'ask_cancel_rate', 'cost_per_session', 'skill_loads_per_session', 'notices_per_session', 'anchor_before_first_edit', 'check_after_last_edit', 'todo_evidence']) {
		const format = r => !r || r.value == null ? 'n/a (n=0)' : `${r.value.toFixed(4)} (n=${r.n})`;
		rows.push(`${key}: ${format(i.before[key])} → ${format(i.after[key])}`);
	}
	return rows;
});
