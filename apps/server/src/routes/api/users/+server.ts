import { json, error, isHttpError } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, desc, eq, sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { getRepository } from '$lib/server/data';
import { getDb } from '$lib/server/db/client';
import { invitation, user as authUser, users } from '$lib/server/db/schema';
import { requireRole } from '$lib/server/auth-guard';
import {
	ensureAppOrg,
	ensureAuthOrgMirror,
	findPendingInvitation,
	normalizeAppRole
} from '$lib/server/auth-config';

/**
 * User directory + invitations (B4/B7). The directory rows come from the
 * repository (app users enriched with real better-auth account state); the
 * invitations live in better-auth's `invitation` table and are consumed by the
 * signup hook in auth-config.ts (matching email → invited role, auto-accept).
 *
 * No SMTP transport is configured on this deployment, so inviting returns a
 * copyable link instead of pretending an email was sent (emailSent: false).
 */

const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
/** Roles an admin may hand out via invitation (owner is deliberately excluded). */
const INVITABLE_ROLES = ['admin', 'editor', 'viewer'];

function inviteUrlFor(email: string, requestOrigin: string | null, apiOrigin: string): string {
	// The login/signup page lives on the SPA origin (WEB_ORIGIN in production,
	// the calling origin in dev). Signing up with the invited email completes
	// the invitation — no special link token is required.
	const base = env.WEB_ORIGIN || requestOrigin || apiOrigin;
	return `${base}/login?email=${encodeURIComponent(email)}`;
}

/** GET /api/users — real directory + pending/expired invitations (admin). */
export const GET: RequestHandler = async ({ locals, request, url }) => {
	requireRole(locals.user, 'admin');
	const items = await getRepository().listUsers();
	let invitations: {
		id: string;
		email: string;
		role: string;
		status: 'pending' | 'expired';
		createdAt: string;
		expiresAt: string;
		inviteUrl: string;
	}[] = [];
	const db = getDb();
	if (db) {
		try {
			const rows = await db
				.select()
				.from(invitation)
				.where(eq(invitation.status, 'pending'))
				.orderBy(desc(invitation.createdAt));
			const origin = request.headers.get('origin');
			invitations = rows.map((r) => ({
				id: r.id,
				email: r.email,
				role: normalizeAppRole(r.role),
				status: r.expiresAt.getTime() < Date.now() ? 'expired' : 'pending',
				createdAt: r.createdAt.toISOString(),
				expiresAt: r.expiresAt.toISOString(),
				inviteUrl: inviteUrlFor(r.email, origin, url.origin)
			}));
		} catch {
			// better-auth tables not migrated — there are no invitations to list.
		}
	}
	return json({ items, invitations, total: items.length });
};

/**
 * POST /api/users — admin actions on the directory:
 *  - { action: 'invite', email, role }        → create/refresh an invitation
 *  - { action: 'revoke-invite', invitationId } → cancel a pending invitation
 */
export const POST: RequestHandler = async ({ locals, request, url }) => {
	const actor = requireRole(locals.user, 'admin');
	const db = getDb();
	if (!db) throw error(503, 'User management requires the database-backed deployment');
	const body = (await request.json().catch(() => ({}))) as {
		action?: string;
		email?: string;
		role?: string;
		invitationId?: string;
	};

	if (body.action === 'invite') {
		const email = (body.email ?? '').trim().toLowerCase();
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw error(400, 'A valid email address is required');
		const role = INVITABLE_ROLES.includes(body.role ?? '') ? (body.role as string) : 'viewer';

		try {
			// Refuse duplicates of existing members (app row or better-auth signup).
			const [existingApp] = await db
				.select({ id: users.id })
				.from(users)
				.where(sql`lower(${users.email}) = ${email}`)
				.limit(1);
			let existingAuth: { id: string } | undefined;
			try {
				[existingAuth] = await db
					.select({ id: authUser.id })
					.from(authUser)
					.where(sql`lower(${authUser.email}) = ${email}`)
					.limit(1);
			} catch {
				/* auth tables not migrated — checked again by the insert below */
			}
			if (existingApp || existingAuth) throw error(409, 'A user with this email already exists');

			// invitation.inviter_id is a FK onto the better-auth user table, so the
			// acting admin must be a real signed-in account (dev-bypass and API-key
			// principals cannot attribute an invitation).
			const [me] = await db
				.select({ id: authUser.id })
				.from(authUser)
				.where(
					sql`${authUser.id} = ${actor.id} or lower(${authUser.email}) = ${actor.email.toLowerCase()}`
				)
				.limit(1);
			if (!me) {
				throw error(
					409,
					'Invitations require a signed-in admin account (dev-bypass and API-key sessions cannot invite)'
				);
			}

			const org = await ensureAppOrg(actor.orgId);
			await ensureAuthOrgMirror(org);

			const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
			const existing = await findPendingInvitation(db, email);
			let id: string;
			if (existing) {
				// Re-inviting refreshes the expiry and role instead of duplicating.
				id = existing.id;
				await db.update(invitation).set({ role, expiresAt }).where(eq(invitation.id, id));
			} else {
				id = `inv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
				await db.insert(invitation).values({
					id,
					organizationId: org.id,
					email,
					role,
					status: 'pending',
					expiresAt,
					createdAt: new Date(),
					inviterId: me.id
				});
			}
			return json({
				id,
				email,
				role,
				status: 'pending',
				expiresAt: expiresAt.toISOString(),
				inviteUrl: inviteUrlFor(email, request.headers.get('origin'), url.origin),
				// Honest signal for the UI: no SMTP transport exists on this server.
				emailSent: false
			});
		} catch (e) {
			if (isHttpError(e)) throw e;
			console.error('[users] invite failed:', e instanceof Error ? e.message : e);
			throw error(503, 'Invitation store unavailable — better-auth tables are not migrated');
		}
	}

	if (body.action === 'revoke-invite') {
		if (!body.invitationId) throw error(400, 'invitationId is required');
		try {
			const [r] = await db
				.update(invitation)
				.set({ status: 'canceled' })
				.where(and(eq(invitation.id, body.invitationId), eq(invitation.status, 'pending')))
				.returning({ id: invitation.id });
			if (!r) throw error(404, 'Pending invitation not found');
			return json({ ok: true });
		} catch (e) {
			if (isHttpError(e)) throw e;
			throw error(503, 'Invitation store unavailable — better-auth tables are not migrated');
		}
	}

	throw error(400, 'Unknown action');
};
