import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRepository } from '$lib/server/data';
import type { PostgresRepository } from '$lib/server/data/postgres';

const SEVERITIES = new Set(['info', 'warning', 'critical']);

/**
 * GET /api/audit — audit stream, newest first, with server-side pagination and
 * filters (gap B32):
 *   ?limit=&offset=         page window (limit 1–500, default 200)
 *   ?from=&to=              ISO timestamps (inclusive)
 *   ?action=&actor=         substring match
 *   ?severity=              info | warning | critical
 * Response: { items, total, limit, offset } — total counts the filtered set,
 * so pagers can compute page counts. Postgres filters/pages in SQL; the seed
 * repo filters in-route.
 */
export const GET: RequestHandler = async ({ url }) => {
	const num = (name: string, fallback: number) => {
		const raw = url.searchParams.get(name);
		if (raw === null || raw === '') return fallback;
		const n = Number(raw);
		return Number.isFinite(n) ? Math.trunc(n) : fallback;
	};
	const str = (name: string) => url.searchParams.get(name)?.trim() || undefined;

	const limit = Math.min(Math.max(num('limit', 200), 1), 500);
	const offset = Math.max(num('offset', 0), 0);
	const from = str('from');
	const to = str('to');
	const action = str('action');
	const actor = str('actor');
	const severityRaw = str('severity');
	const severity =
		severityRaw && SEVERITIES.has(severityRaw)
			? (severityRaw as 'info' | 'warning' | 'critical')
			: undefined;

	const repo = getRepository();

	// Postgres: SQL-side WHERE/ORDER/LIMIT via the paged repository method.
	const paged = repo as Partial<Pick<PostgresRepository, 'listAuditPaged'>>;
	if (typeof paged.listAuditPaged === 'function') {
		const page = await paged.listAuditPaged({ limit, offset, from, to, action, actor, severity });
		return json(page);
	}

	// Seed repo: filter + page in-route (small fixed dataset).
	let items = await repo.listAudit();
	items = items.slice().sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
	const fromMs = from ? Date.parse(from) : NaN;
	if (!Number.isNaN(fromMs)) items = items.filter((i) => Date.parse(i.timestamp) >= fromMs);
	const toMs = to ? Date.parse(to) : NaN;
	if (!Number.isNaN(toMs)) items = items.filter((i) => Date.parse(i.timestamp) <= toMs);
	if (action) items = items.filter((i) => i.action.toLowerCase().includes(action.toLowerCase()));
	if (actor) items = items.filter((i) => i.actor.toLowerCase().includes(actor.toLowerCase()));
	if (severity) items = items.filter((i) => i.severity === severity);
	const total = items.length;
	return json({ items: items.slice(offset, offset + limit), total, limit, offset });
};
