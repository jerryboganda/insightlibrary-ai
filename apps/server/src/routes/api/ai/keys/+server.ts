import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { aiKeyInputSchema, providerIdSchema } from '@insightlibrary/schemas';
import { storeKey, deleteKey } from '$lib/server/ai/credentials';
import { encryptionAvailable } from '$lib/server/ai/providers';
import { requireRole } from '$lib/server/auth-guard';

/** POST — store/overwrite an API key (encrypted). Body = AiKeyInput. */
export const POST: RequestHandler = async ({ request, locals }) => {
	// Org-shared keys require admin; personal (user-scope) keys just need sign-in.
	const parsed = aiKeyInputSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) throw error(400, 'Invalid key input');
	if (parsed.data.scope === 'org') requireRole(locals.user, 'admin');
	if (!encryptionAvailable()) {
		throw error(503, 'Server key storage is disabled — set MASTER_ENCRYPTION_KEY on the server.');
	}
	const scope = { orgId: locals.user?.orgId || 'org_1', userId: locals.user?.id };
	if (parsed.data.scope === 'user' && !scope.userId) throw error(401, 'Sign in to store a personal key');
	try {
		await storeKey(parsed.data, scope);
	} catch (e) {
		throw error(500, e instanceof Error ? e.message : 'Failed to store key');
	}
	return json({ ok: true });
};

/** DELETE — remove a stored key. ?provider=..&scope=org|user */
export const DELETE: RequestHandler = async ({ url, locals }) => {
	const provider = providerIdSchema.safeParse(url.searchParams.get('provider'));
	if (!provider.success) throw error(400, 'Valid provider query param required');
	const kscope = url.searchParams.get('scope') === 'user' ? 'user' : 'org';
	await deleteKey(provider.data, {
		orgId: locals.user?.orgId || 'org_1',
		userId: locals.user?.id,
		scope: kscope
	});
	return json({ ok: true });
};
