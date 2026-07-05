/**
 * Role-based access control for hosted-tier admin mutations. Roles are resolved
 * by the auth hook (better-auth in prod; the seeded owner in dev-bypass), so
 * requireRole('admin') passes in local dev and is enforced with real sessions.
 */
import { error } from '@sveltejs/kit';
import type { SessionUser } from '@insightlibrary/schemas';

export type Role = SessionUser['role'];
const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

export function requireRole(user: SessionUser | null, min: Role): SessionUser {
	if (!user) throw error(401, 'Sign in required');
	if ((RANK[user.role] ?? 0) < RANK[min]) throw error(403, `Requires ${min} role or higher`);
	return user;
}
