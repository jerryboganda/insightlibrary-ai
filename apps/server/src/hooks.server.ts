import { json, type Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { env } from '$env/dynamic/private';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { SessionUser } from '@insightlibrary/schemas';
import { DEV_SESSION_USER, getAuth, isAuthEnabled } from '$lib/server/auth';
import { getDb } from '$lib/server/db/client';
import { apiKeys } from '$lib/server/db/schema';
import { recordAudit } from '$lib/server/audit';

/**
 * Origins allowed to call this API cross-origin:
 * - the web SPA's deploy origin (WEB_ORIGIN env)
 * - the Vite dev server
 * - Tauri webview origins (macOS/Linux tauri://localhost, Windows http://tauri.localhost)
 */
function allowedOrigins(): Set<string> {
	const origins = new Set([
		'http://localhost:5173',
		'http://localhost:4173',
		'tauri://localhost',
		'http://tauri.localhost'
	]);
	if (env.WEB_ORIGIN) origins.add(env.WEB_ORIGIN);
	return origins;
}

const CORS_HEADERS = {
	'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
	// x-ai-oauth-token: sent by the desktop copilot (ChatGPT-subscription path) and
	// read by /api/copilot — must be preflight-allowed for Tauri origins.
	'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-ai-oauth-token',
	'Access-Control-Allow-Credentials': 'true',
	'Access-Control-Max-Age': '86400'
};

const cors: Handle = async ({ event, resolve }) => {
	const origin = event.request.headers.get('origin');
	const allowed = origin !== null && allowedOrigins().has(origin);

	if (event.request.method === 'OPTIONS') {
		if (!allowed) return new Response(null, { status: 403 });
		return new Response(null, {
			status: 204,
			headers: { 'Access-Control-Allow-Origin': origin, ...CORS_HEADERS }
		});
	}

	const response = await resolve(event);
	if (allowed) {
		response.headers.set('Access-Control-Allow-Origin', origin);
		response.headers.set('Access-Control-Allow-Credentials', 'true');
		response.headers.append('Vary', 'Origin');
	}
	return response;
};

// ── API-key auth (admin-minted keys) ────────────────────────────────────────

const API_KEY_PREFIX = 'sk_live_';
/** Avoid an UPDATE per request on hot keys — refresh last_used_at at most once a minute. */
const LAST_USED_THROTTLE_MS = 60_000;

/**
 * Resolve `Authorization: Bearer sk_live_…` to an org-scoped principal.
 * Keys are stored as sha256 hex digests of the full secret — the same scheme
 * the mint route uses (routes/api/api-keys/+server.ts). Revoking a key deletes
 * its row, so a missing hash means the key is invalid or revoked.
 */
async function resolveApiKeyUser(token: string): Promise<SessionUser | null> {
	const db = getDb();
	if (!db) return null;
	const tokenHash = createHash('sha256').update(token).digest('hex');
	const [key] = await db.select().from(apiKeys).where(eq(apiKeys.tokenHash, tokenHash)).limit(1);
	if (!key) return null;
	if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
		// Fire-and-forget: never let bookkeeping block or fail the request.
		void db
			.update(apiKeys)
			.set({ lastUsedAt: new Date() })
			.where(eq(apiKeys.id, key.id))
			.catch((e) =>
				console.error(
					'[auth] api-key last_used_at update failed:',
					e instanceof Error ? e.message : e
				)
			);
	}
	return {
		id: `apikey_${key.id}`,
		name: key.name,
		email: `${key.id}@api-keys.insightlibrary.local`,
		role: 'editor',
		orgId: key.orgId,
		orgName: '',
		tenantId: key.orgId
	};
}

const auth: Handle = async ({ event, resolve }) => {
	if (!isAuthEnabled()) {
		// Dev bypass: every request is the seeded owner.
		event.locals.user = DEV_SESSION_USER;
		return resolve(event);
	}

	// Admin-minted API keys (headless access). Only tokens with the sk_live_
	// prefix are treated as API keys — plain bearer session tokens fall through
	// to better-auth (bearer plugin) below.
	const authz = event.request.headers.get('authorization');
	if (authz && /^bearer /i.test(authz)) {
		const token = authz.slice(7).trim();
		if (token.startsWith(API_KEY_PREFIX)) {
			let principal: SessionUser | null = null;
			try {
				principal = await resolveApiKeyUser(token);
			} catch (e) {
				console.error('[auth] api-key lookup failed:', e instanceof Error ? e.message : e);
			}
			if (!principal) {
				// This response short-circuits the audit handle, so record the
				// rejected attempt here (never log the token itself).
				recordAudit({
					actor: 'anonymous',
					action: 'api-key.rejected',
					target: `${event.request.method} ${event.url.pathname} → 401`,
					severity: 'warning'
				});
				return json({ message: 'Invalid or revoked API key' }, { status: 401 });
			}
			event.locals.user = principal;
			return resolve(event);
		}
	}

	try {
		const authApi = getAuth();
		if (!authApi) {
			event.locals.user = null;
			return resolve(event);
		}
		const session = await authApi.api.getSession({ headers: event.request.headers });
		if (session?.user) {
			const u = session.user;
			event.locals.user = {
				id: u.id,
				name: u.name ?? u.email,
				email: u.email,
				role: (u.role as SessionUser['role']) ?? 'viewer',
				orgId: session.session?.activeOrganizationId ?? '',
				orgName: '',
				tenantId: session.session?.activeOrganizationId ?? ''
			};
		} else {
			event.locals.user = null;
		}
	} catch (e) {
		// Session lookup failed (e.g. better-auth tables not migrated yet, or a
		// transient DB blip) — treat the request as anonymous rather than 500ing
		// the entire API. Data endpoints don't require auth.
		console.error('[auth] session lookup failed:', e instanceof Error ? e.message : e);
		event.locals.user = null;
	}
	return resolve(event);
};

const AUDIT_VERBS: Record<string, string> = {
	POST: 'create',
	PUT: 'update',
	PATCH: 'update',
	DELETE: 'delete'
};

/**
 * Request audit: every mutating /api/* call is persisted to audit_logs
 * (asynchronously — persistence can never block or fail the request) and
 * echoed to the console as a secondary sink.
 */
const audit: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	const method = event.request.method;
	if (method !== 'GET' && method !== 'OPTIONS' && event.url.pathname.startsWith('/api/')) {
		const path = event.url.pathname;
		const actor = event.locals.user?.email ?? 'anonymous';
		console.info(`[audit] ${actor} ${method} ${path} -> ${response.status}`);
		const resource = path.split('/')[2] || 'api';
		recordAudit({
			orgId: event.locals.user?.orgId,
			actor,
			action: `${resource}.${AUDIT_VERBS[method] ?? method.toLowerCase()}`,
			target: `${method} ${path} → ${response.status}`,
			severity: response.status >= 500 ? 'critical' : response.status >= 400 ? 'warning' : 'info'
		});
	}
	return response;
};

export const handle = sequence(cors, auth, audit);
