import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { aiProvidersResponseSchema, aiProviderSettingsInputSchema } from '@insightlibrary/schemas';
import { getOrgProviderSettings, listProviderStatus } from '$lib/server/ai/credentials';
import {
	getRouter,
	encryptionAvailable,
	invalidateOrgAiRouting,
	PROVIDERS,
	TASK_KINDS
} from '$lib/server/ai/providers';
import { embeddingsStatus } from '$lib/server/ai/embeddings';
import { getDb } from '$lib/server/db/client';
import { providerSettings } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { requireRole } from '$lib/server/auth-guard';
import { recordAudit } from '$lib/server/audit';

/**
 * GET — provider status for the settings UI (never returns key material).
 * Includes the org's routing preferences (defaultProvider + taskRouting), the
 * EFFECTIVE per-task provider after env fallbacks, and embeddings health.
 */
export const GET: RequestHandler = async ({ locals }) => {
	const orgId = locals.user?.orgId || 'org_1';
	const scope = { orgId, userId: locals.user?.id };
	const router = getRouter(orgId);
	const [statuses, settings, embeddings, activeChatProvider, taskProviders] = await Promise.all([
		listProviderStatus(scope),
		getOrgProviderSettings(orgId),
		embeddingsStatus(orgId),
		router.activeProviderAsync('chat'),
		router.taskProviders()
	]);
	return json(
		aiProvidersResponseSchema.parse({
			providers: statuses,
			activeChatProvider,
			encryptionAvailable: encryptionAvailable(),
			defaultProvider: settings.defaultProvider,
			taskRouting: settings.taskRouting,
			taskProviders,
			embeddings
		})
	);
};

/**
 * PUT — org routing defaults ({ defaultProvider?, taskRouting? }). Omitted
 * fields are left unchanged; defaultProvider: null clears the default. Values
 * are validated against the known providers/tasks, and the routing cache is
 * invalidated so the router applies the change within seconds.
 */
export const PUT: RequestHandler = async ({ request, locals }) => {
	requireRole(locals.user, 'admin');
	const orgId = locals.user?.orgId || 'org_1';
	const parsed = aiProviderSettingsInputSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) throw error(400, 'Invalid settings body');
	const body = parsed.data;

	if (body.defaultProvider != null && !(body.defaultProvider in PROVIDERS)) {
		throw error(400, `Unknown provider '${body.defaultProvider}'`);
	}
	const taskRouting: Record<string, string> | undefined = body.taskRouting && { ...body.taskRouting };
	if (taskRouting) {
		for (const [task, provider] of Object.entries(taskRouting)) {
			if (!(TASK_KINDS as readonly string[]).includes(task)) throw error(400, `Unknown task '${task}'`);
			if (!(provider in PROVIDERS)) throw error(400, `Unknown provider '${provider}' for task '${task}'`);
		}
	}

	const db = getDb();
	if (!db) throw error(503, 'Database required to persist provider settings');

	// Merge with the existing row so a partial PUT doesn't clobber the other field.
	const [existing] = await db.select().from(providerSettings).where(eq(providerSettings.orgId, orgId));
	const nextDefault =
		body.defaultProvider !== undefined ? body.defaultProvider : (existing?.defaultProvider ?? null);
	const nextRouting = taskRouting !== undefined ? taskRouting : (existing?.taskRouting ?? {});

	await db
		.insert(providerSettings)
		.values({ orgId, defaultProvider: nextDefault, taskRouting: nextRouting })
		.onConflictDoUpdate({
			target: providerSettings.orgId,
			set: { defaultProvider: nextDefault, taskRouting: nextRouting, updatedAt: new Date() }
		});

	invalidateOrgAiRouting(orgId);
	recordAudit({
		orgId,
		actor: locals.user?.email ?? 'admin',
		action: 'ai.provider_settings.updated',
		target: `default=${nextDefault ?? 'none'} routing=${JSON.stringify(nextRouting)}`
	});
	return json({ ok: true, defaultProvider: nextDefault, taskRouting: nextRouting });
};
