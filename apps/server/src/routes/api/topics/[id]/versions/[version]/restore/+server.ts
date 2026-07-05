import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireRole } from '$lib/server/auth-guard';
import { restoreTopicVersion } from '$lib/server/refinery/versioning';

/**
 * POST /api/topics/[id]/versions/[version]/restore (editor+) — write the
 * selected version's snapshot back to topics.sections and record the restore
 * as a NEW topic_version (append-only history; see refinery/versioning.ts).
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	const user = requireRole(locals.user, 'editor');
	const version = Number(params.version);
	if (!Number.isInteger(version) || version < 1) throw error(400, 'Invalid version number');

	const res = await restoreTopicVersion(params.id, version, { createdBy: user.email || user.id });
	if (!res.ok) {
		if (res.reason === 'no database') throw error(503, 'Version restore requires the database');
		throw error(404, res.reason ?? 'Version not found');
	}
	return json(res);
};
