import { daily, QueryError, run } from './query-lib.mjs';

const usage = 'node skill-days.mjs SKILL [PROJECT]';
run(usage, args => {
	if (args.length > 2) throw new QueryError(usage);
	const [skill, project] = args, { rows, index, header } = daily(project);
	if (!index.offeredSkills.includes(skill) && !Object.values(index.days).some(projects => Object.values(projects).some(a => Object.hasOwn(a.skillSessions, skill)))) throw new QueryError('Skill not found in index.');
	return [header, `${skill}: sessions that loaded the skill, by session start date`, ...rows.map(({ day, agg }) => `${day} ${agg && Object.hasOwn(agg.skillSessions, skill) ? agg.skillSessions[skill] : 0}`)];
});
