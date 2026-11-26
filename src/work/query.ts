import { comparisonText } from "./wording.ts";
/** The `items` view of `evals_query` and its line in `findings`: numbers, names, and titles in double quotes. */
import type { Comparison, WorkModel } from "./model.ts";

const usd = (v: number | null) => (v === null ? "n/a" : `$${v.toFixed(2)}`);
const mins = (m: number) => (m < 90 ? `${Math.round(m)}m` : m < 2880 ? `${(m / 60).toFixed(1)}h` : `${(m / 1440).toFixed(1)}d`);
/** A title for agent output: quoted, inner quotes swapped, at most 50 characters. */
const quote = (title: string) => `"${Array.from(title.replace(/"/g, "'")).slice(0, 50).join("")}"`;

function summary(c: Comparison) {
	const kind = c.kind === "delegated" ? "Work handed to subagents" : "Work done by the main agent";
	return `${kind} by ${c.dimension}: ${comparisonText(c, en => en)}`;
}

export function itemsView(w: WorkModel | null): string[] {
	if (!w) return ["no work items yet: the user can run /evals extract"];
	const kinds = Object.entries(w.closeKinds).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ");
	const stalls = Object.entries(w.stallMs).filter(([, v]) => v).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${mins(v / 60_000)}`).join(", ");
	const out = [
		"item = one todo task, in_progress to completed/deleted (main sessions)",
		`finished ${w.completed} (handed to subagents ${w.delegated}), in progress ${w.inProgress}, not started ${w.pending}, deleted ${w.deleted}`,
		`finished cost ${usd(w.cost.main + w.cost.child)} = subagents ${usd(w.cost.child)} exact + main ${usd(w.cost.main)} estimated (even split among items open at once; ${usd(w.cost.unattributed)} outside any item)`,
		`median item ${usd(w.cost.median)}, ${w.cost.medianMinutes ?? "n/a"} min in progress`,
		`closed by: ${kinds || "none"}`,
		`stall time in finished items, by what woke the main: ${stalls || "none"}`,
		"Median costs for similar work (differences, not causes):",
	];
	for (const c of w.compare) out.push(summary(c));
	if (w.open.length) out.push("open, stopped where / waiting on / how long:");
	for (const o of w.open.slice(0, 4)) out.push(`- ${quote(o.title || o.key)} ${o.kind}${o.on ? ` on ${o.on}` : ""}, ${mins(o.waitMinutes)}`);
	const costly = [...w.list].sort((a, b) => b.main + b.child - (a.main + a.child)).slice(0, 3);
	if (costly.length) out.push("costliest finished:");
	for (const r of costly) out.push(`- ${quote(r.title || r.key)} ${usd(r.main + r.child)} (main ${usd(r.main)} + sub ${usd(r.child)}), ${mins(r.minutes)}, ${r.closeKind}`);
	return out;
}

/** One findings line when something stands out: a like-with-like difference with enough items, or a long wait on others. */
export function itemsFinding(w: WorkModel | null): string | undefined {
	if (!w) return undefined;
	// Model first: a role split mixes kinds of work (planning vs building), and versions overlap other changes.
	const order = ["model", "anchorloop", "role"];
	const cheaper = w.compare.filter((c) => c.verdict.kind === "cheaper" || c.verdictLines.kind === "cheaper").sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "delegated" ? -1 : 1) || order.indexOf(a.dimension) - order.indexOf(b.dimension))[0];
	const waits = w.open.filter((o) => o.kind !== "human" && o.kind !== "working" && o.waitMinutes >= 60);
	const parts: string[] = [];
	if (cheaper) parts.push(`${summary(cheaper)} This is a difference, not its cause.`);
	if (waits.length) parts.push(`${waits.length} open item(s) waiting over 1h, longest ${mins(Math.max(...waits.map((o) => o.waitMinutes)))} on ${waits.sort((a, b) => b.waitMinutes - a.waitMinutes)[0].on ?? waits[0].kind}`);
	return parts.length ? `Work items: ${parts.join("; ")} → items` : undefined;
}
