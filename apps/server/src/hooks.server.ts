import type { Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { env } from '$env/dynamic/private';
import type { SessionUser } from '@insightlibrary/schemas';
import { DEV_SESSION_USER, getAuth, isAuthEnabled } from '$lib/server/auth';

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
	'Access-Control-Allow-Headers': 'Authorization, Content-Type',
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

const auth: Handle = async ({ event, resolve }) => {
	if (!isAuthEnabled()) {
		// Dev bypass: every request is the seeded owner.
		event.locals.user = DEV_SESSION_USER;
		return resolve(event);
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

/** Lightweight request audit — expands to persisted audit_logs writes for mutations. */
const audit: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	if (event.request.method !== 'GET' && event.url.pathname.startsWith('/api/')) {
		console.info(
			`[audit] ${event.locals.user?.email ?? 'anon'} ${event.request.method} ${event.url.pathname} -> ${response.status}`
		);
	}
	return response;
};

export const handle = sequence(cors, auth, audit);
