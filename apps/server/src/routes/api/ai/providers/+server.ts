import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { aiProvidersResponseSchema } from '@insightlibrary/schemas';
import { listProviderStatus } from '$lib/server/ai/credentials';
import { getRouter, encryptionAvailable } from '$lib/server/ai/providers';
import { getDb } from '$lib/server/db/client';
import { providerSettings } from '$lib/server/db/schema';
import { requireRole } from '$lib/server/auth-guard';

/** GET — provider status for the settings UI (never returns key material). */
export const GET: RequestHandler = async ({ locals }) => {
	const scope = { orgId: locals.user?.orgId || 'org_1', userId: locals.user?.id };
	const statuses = await listProviderStatus(scope);
	return json(
		aiProvidersResponseSchema.parse({
			providers: statuses,
			activeChatProvider: getRouter().activeProvider('chat'),
			encryptionAvailable: encryptionAvailable()
		})
	);
};

/** PUT — org routing defaults ({ defaultProvider?, taskRouting? }). */
export const PUT: RequestHandler = async ({ request, locals }) => {
	requireRole(locals.user, 'admin');
	const orgId = locals.user?.orgId || 'org_1';
	const body = (await request.json().catch(() => null)) as {
		defaultProvider?: string;
		taskRouting?: Record<string, string>;
	} | null;
	if (!body) throw error(400, 'Invalid settings body');
	const db = getDb();
	if (!db) throw error(503, 'Database required to persist provider settings');
	await db
		.insert(providerSettings)
		.values({ orgId, defaultProvider: body.defaultProvider ?? null, taskRouting: body.taskRouting ?? {} })
		.onConflictDoUpdate({
			target: providerSettings.orgId,
			set: { defaultProvider: body.defaultProvider ?? null, taskRouting: body.taskRouting ?? {}, updatedAt: new Date() }
		});
	return json({ ok: true });
};
