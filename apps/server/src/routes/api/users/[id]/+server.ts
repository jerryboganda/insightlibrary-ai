import { json, error, isHttpError } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { getDb, type Db } from '$lib/server/db/client';
import { session as authSession, user as authUser, users } from '$lib/server/db/schema';
import { requireRole } from '$lib/server/auth-guard';
import { getAuth } from '$lib/server/auth';
import { APP_ROLES, normalizeAppRole, syncAuthUserToApp } from '$lib/server/auth-config';

/**
 * Per-user admin management (B5/B7). Role/status changes are written to BOTH
 * stores: the app `users` row (what the directory lists) and the better-auth
 * `user` row (what sessions/RBAC actually read), so a change here is real —
 * suspending bans the login account and revokes its sessions.
 */

const msg = (e: unknown) => {
	if (e && typeof e === 'object') {
		const body = (e as { body?: { message?: string } }).body;
		if (body?.message) return body.message;
	}
	return e instanceof Error ? e.message : 'unknown error';
};

/** Find the better-auth account behind a directory row (id or email match). */
async function resolveAuthUser(db: Db, appId: string): Promise<{ id: string; email: string } | null> {
	const [appRow] = await db
		.select({ email: users.email })
		.from(users)
		.where(eq(users.id, appId))
		.limit(1);
	try {
		const cond = appRow
			? sql`${authUser.id} = ${appId} or lower(${authUser.email}) = ${appRow.email.toLowerCase()}`
			: sql`${authUser.id} = ${appId}`;
		const [row] = await db
			.select({ id: authUser.id, email: authUser.email })
			.from(authUser)
			.where(cond)
			.limit(1);
		return row ?? null;
	} catch {
		return null; // better-auth tables not migrated
	}
}

/** PATCH /api/users/[id] { role?, status? } — update a user's role/status (admin). */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	requireRole(locals.user, 'admin');
	const db = getDb();
	if (!db) throw error(503, 'A database is required');
	const body = (await request.json().catch(() => ({}))) as { role?: string; status?: string };
	const set: Partial<{ role: string; status: string }> = {};
	if (body.role && (APP_ROLES as readonly string[]).includes(body.role)) set.role = body.role;
	if (body.status && ['active', 'suspended'].includes(body.status)) set.status = body.status;
	if (!Object.keys(set).length) throw error(400, 'nothing to update');

	let [r] = await db
		.update(users)
		.set(set)
		.where(and(eq(users.id, params.id), eq(users.orgId, locals.user?.orgId || 'org_1')))
		.returning();

	// Auth-only signups (predating the mirroring hooks) can still be managed:
	// heal the app mirror on demand, then apply the change.
	if (!r) {
		try {
			const [au] = await db.select().from(authUser).where(eq(authUser.id, params.id)).limit(1);
			if (au) {
				await syncAuthUserToApp(db, au, {
					role: set.role ? normalizeAppRole(set.role) : undefined,
					adoptRole: Boolean(set.role)
				});
				[r] = await db.update(users).set(set).where(eq(users.id, params.id)).returning();
			}
		} catch {
			/* auth tables not migrated — fall through to 404 */
		}
	}
	if (!r) throw error(404, 'user not found');

	// Mirror into better-auth so the change is enforced on real sessions:
	// role drives RBAC on the next session read; suspension bans the account
	// (sign-in blocked) and revokes all live sessions.
	const account = await resolveAuthUser(db, r.id);
	if (account) {
		try {
			if (set.role) {
				await db.update(authUser).set({ role: set.role }).where(eq(authUser.id, account.id));
			}
			if (set.status === 'suspended') {
				await db
					.update(authUser)
					.set({ banned: true, banReason: 'Suspended by admin', banExpires: null })
					.where(eq(authUser.id, account.id));
				await db.delete(authSession).where(eq(authSession.userId, account.id));
			} else if (set.status === 'active') {
				await db
					.update(authUser)
					.set({ banned: false, banReason: null, banExpires: null })
					.where(eq(authUser.id, account.id));
			}
		} catch (e) {
			console.error('[users] better-auth mirror failed:', msg(e));
		}
	}
	return json({ id: r.id, role: r.role, status: r.status });
};

/**
 * POST /api/users/[id] — security actions against the login account (admin):
 *  - { action: 'revoke-sessions' } → force logout everywhere
 *  - { action: 'reset-password' }  → issue a one-time temporary password
 *    (no SMTP transport exists, so the admin hands it over out-of-band; all
 *    existing sessions are revoked). Uses the better-auth admin API with the
 *    caller's own session for authorization.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireRole(locals.user, 'admin');
	const db = getDb();
	if (!db) throw error(503, 'A database is required');
	const authApi = getAuth();
	if (!authApi) throw error(501, 'Auth is disabled on this deployment (dev bypass)');
	const body = (await request.json().catch(() => ({}))) as { action?: string };

	const target = await resolveAuthUser(db, params.id);
	if (!target) throw error(404, 'No login account exists for this user (seed/local record)');

	if (body.action === 'revoke-sessions') {
		let revoked = 0;
		try {
			const [row] = await db
				.select({ n: sql<number>`count(*)::int` })
				.from(authSession)
				.where(eq(authSession.userId, target.id));
			revoked = Number(row?.n ?? 0);
		} catch {
			/* count is informational */
		}
		try {
			await authApi.api.revokeUserSessions({
				body: { userId: target.id },
				headers: request.headers
			});
		} catch (e) {
			// The caller passed requireRole but may lack a better-auth admin session
			// (legacy account with no role). The direct delete below is the same
			// operation the admin plugin performs.
			console.error('[users] admin revoke-sessions API failed, falling back:', msg(e));
			await db.delete(authSession).where(eq(authSession.userId, target.id));
		}
		return json({ ok: true, revoked });
	}

	if (body.action === 'reset-password') {
		const tempPassword = `Il-${randomBytes(12).toString('base64url')}`;
		try {
			await authApi.api.setUserPassword({
				body: { userId: target.id, newPassword: tempPassword },
				headers: request.headers
			});
		} catch (e) {
			if (isHttpError(e)) throw e;
			throw error(400, `Password reset rejected: ${msg(e)}`);
		}
		// A reset must also end existing sessions, or the old holder stays in.
		try {
			await authApi.api.revokeUserSessions({
				body: { userId: target.id },
				headers: request.headers
			});
		} catch {
			try {
				await db.delete(authSession).where(eq(authSession.userId, target.id));
			} catch {
				/* sessions table unavailable — password change alone still stands */
			}
		}
		return json({ ok: true, tempPassword });
	}

	throw error(400, 'Unknown action');
};
