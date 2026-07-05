import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin, bearer, organization } from 'better-auth/plugins';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb, type Db } from './db/client';
import * as schema from './db/schema';

/**
 * Static better-auth instance — kept in its own module (no $env, no SvelteKit
 * imports) so the `@better-auth/cli` can import it to generate/migrate the auth
 * schema:
 *   npx @better-auth/cli migrate --config src/lib/server/auth-config.ts -y
 *
 * Built only when DATABASE_URL is set. Uses process.env so it works both inside
 * the SvelteKit server (adapter-node) and under the CLI. Web clients get cookie
 * sessions; the Tauri client uses the bearer plugin (token in the OS keyring).
 *
 * This module is also the bridge between better-auth's identity tables and the
 * app's own users/organizations model (gaps B4/B7/C10):
 *  - user.create hooks mirror every real signup into the app `users` table
 *    (the very first signup becomes 'owner'; a pending invitation assigns the
 *    invited role and is marked accepted),
 *  - session.create hooks pin `activeOrganizationId` to the member's org and
 *    refresh the app row's last_active_at on every sign-in,
 *  - org hooks + ensureAppOrg() mirror better-auth organizations into the app
 *    `organizations` table so org-scoped FKs (audit_logs, org_settings, …)
 *    never dangle and the org_1 fallback stays consistent.
 */

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ── Roles ───────────────────────────────────────────────────────────────────

/** The only roles the platform supports (users.role, RBAC guard, admin console). */
export const APP_ROLES = ['owner', 'admin', 'editor', 'viewer'] as const;
export type AppRole = (typeof APP_ROLES)[number];

/** Map any better-auth role value (unset, 'user', or a CSV list) to an app role. */
export function normalizeAppRole(role: string | null | undefined): AppRole {
	const first = (role ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
	return (APP_ROLES as readonly string[]).includes(first) ? (first as AppRole) : 'viewer';
}

// ── Default org & app-org mirroring (C10) ───────────────────────────────────

export const DEFAULT_ORG_ID = 'org_1';
/** Mirrors data/seed.ts seedOrg — the workspace every signup joins for now. */
const DEFAULT_ORG = { id: DEFAULT_ORG_ID, name: 'InsightLibrary Demo', slug: 'demo', tenantId: '9021' };

export interface ResolvedOrg {
	id: string;
	name: string;
	tenantId: string;
}

/** Per-process cache of app `organizations` rows known to exist (id → row). */
const knownOrgs = new Map<string, ResolvedOrg>();

/** Insert an app organizations row, retrying once with a suffixed slug on collision. */
async function insertAppOrg(
	db: Db,
	row: { id: string; name: string; slug: string; tenantId: string }
): Promise<void> {
	try {
		await db
			.insert(schema.organizations)
			.values(row)
			.onConflictDoNothing({ target: schema.organizations.id });
	} catch {
		// Unique slug collision with a different org — retry deterministically.
		await db
			.insert(schema.organizations)
			.values({ ...row, slug: `${row.slug}-${row.id.slice(-6)}` })
			.onConflictDoNothing({ target: schema.organizations.id });
	}
}

/**
 * Resolve an org id (typically session.activeOrganizationId) to an app
 * `organizations` row that is guaranteed to exist — mirroring a better-auth
 * organization into the app table on first sight, and falling back to the
 * seeded default org for unknown/absent ids. Never throws; results are cached
 * per process so the auth hook stays cheap on hot paths.
 */
export async function ensureAppOrg(orgId?: string | null): Promise<ResolvedOrg> {
	const id = orgId || DEFAULT_ORG_ID;
	const cached = knownOrgs.get(id);
	if (cached) return cached;
	const fallback: ResolvedOrg = {
		id: DEFAULT_ORG_ID,
		name: DEFAULT_ORG.name,
		tenantId: DEFAULT_ORG.tenantId
	};
	const db = getDb();
	if (!db) return fallback;
	try {
		const [app] = await db
			.select()
			.from(schema.organizations)
			.where(eq(schema.organizations.id, id))
			.limit(1);
		if (app) {
			const v: ResolvedOrg = { id: app.id, name: app.name, tenantId: app.tenantId };
			knownOrgs.set(id, v);
			return v;
		}
		// Read-through mirror: a better-auth organization that predates the
		// mirroring hooks. Adopt it into the app table on first sight.
		try {
			const [ba] = await db
				.select()
				.from(schema.organization)
				.where(eq(schema.organization.id, id))
				.limit(1);
			if (ba) {
				await insertAppOrg(db, { id: ba.id, name: ba.name, slug: ba.slug || ba.id, tenantId: ba.id });
				const v: ResolvedOrg = { id: ba.id, name: ba.name, tenantId: ba.id };
				knownOrgs.set(id, v);
				return v;
			}
		} catch {
			// better-auth tables not migrated yet — fall through to the default org.
		}
		if (id !== DEFAULT_ORG_ID) {
			const def = await ensureAppOrg(DEFAULT_ORG_ID);
			knownOrgs.set(id, def); // alias unknown ids so we don't re-query per request
			return def;
		}
		// Fresh database without the seed: create the default org row itself.
		await insertAppOrg(db, DEFAULT_ORG);
		knownOrgs.set(DEFAULT_ORG_ID, fallback);
		return fallback;
	} catch (e) {
		console.error('[auth-sync] ensureAppOrg failed:', msg(e));
		return fallback;
	}
}

/** Ensure a better-auth `organization` row mirrors the app org (member/invitation FKs). */
export async function ensureAuthOrgMirror(org: { id: string; name: string }): Promise<void> {
	const db = getDb();
	if (!db) return;
	try {
		const [existing] = await db
			.select({ id: schema.organization.id })
			.from(schema.organization)
			.where(eq(schema.organization.id, org.id))
			.limit(1);
		if (existing) return;
		await db
			.insert(schema.organization)
			.values({
				id: org.id,
				name: org.name,
				slug: org.id === DEFAULT_ORG_ID ? DEFAULT_ORG.slug : org.id,
				createdAt: new Date()
			})
			.onConflictDoNothing();
	} catch (e) {
		console.error('[auth-sync] ensureAuthOrgMirror failed:', msg(e));
	}
}

// ── Invitations & user mirroring (B4/B7) ────────────────────────────────────

/** Latest live (pending, unexpired) invitation for an email, or null. */
export async function findPendingInvitation(
	db: Db,
	email: string
): Promise<typeof schema.invitation.$inferSelect | null> {
	try {
		const rows = await db
			.select()
			.from(schema.invitation)
			.where(
				and(
					sql`lower(${schema.invitation.email}) = ${email.toLowerCase()}`,
					eq(schema.invitation.status, 'pending')
				)
			)
			.orderBy(desc(schema.invitation.createdAt))
			.limit(1);
		const inv = rows[0];
		if (!inv || inv.expiresAt.getTime() < Date.now()) return null;
		return inv;
	} catch {
		return null; // better-auth tables not migrated
	}
}

function initialsOf(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	const initials = parts
		.slice(0, 2)
		.map((p) => p[0]!.toUpperCase())
		.join('');
	return initials || 'U';
}

/**
 * Mirror a better-auth account into the app `users` table (B4). Rows matched by
 * email are adopted in place (their id is kept; role is only overwritten when
 * `adoptRole` is set — e.g. first-user owner or an invitation role). New rows
 * take the better-auth user id so the two tables stay joinable.
 */
export async function syncAuthUserToApp(
	db: Db,
	account: { id: string; name?: string | null; email: string },
	opts: { role?: AppRole; adoptRole?: boolean; orgId?: string } = {}
): Promise<void> {
	const name = account.name?.trim() || account.email;
	const [existing] = await db
		.select({ id: schema.users.id })
		.from(schema.users)
		.where(sql`lower(${schema.users.email}) = ${account.email.toLowerCase()}`)
		.limit(1);
	if (existing) {
		await db
			.update(schema.users)
			.set({
				name,
				...(opts.role && opts.adoptRole ? { role: opts.role } : {}),
				lastActiveAt: new Date()
			})
			.where(eq(schema.users.id, existing.id));
		return;
	}
	const org = await ensureAppOrg(opts.orgId);
	await db
		.insert(schema.users)
		.values({
			id: account.id,
			orgId: org.id,
			name,
			email: account.email,
			role: opts.role ?? 'viewer',
			initials: initialsOf(name),
			status: 'active',
			lastActiveAt: new Date()
		})
		.onConflictDoNothing();
}

// ── better-auth instance ────────────────────────────────────────────────────

function build() {
	// Shared drizzle client (db/client.ts) — same pool as the repository/refinery.
	const db = getDb()!;
	return betterAuth({
		secret: process.env.BETTER_AUTH_SECRET,
		baseURL: process.env.BETTER_AUTH_URL,
		database: drizzleAdapter(db, { provider: 'pg' }),
		emailAndPassword: { enabled: true },
		trustedOrigins: process.env.WEB_ORIGIN ? [process.env.WEB_ORIGIN] : [],
		databaseHooks: {
			user: {
				create: {
					// First signup owns the deployment; invited signups get their
					// invited role; everyone else starts as viewer (admin plugin default).
					before: async (u) => {
						try {
							const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.user);
							if (Number(n) === 0) return { data: { ...u, role: 'owner' } };
							const inv = await findPendingInvitation(db, u.email);
							if (inv?.role) return { data: { ...u, role: normalizeAppRole(inv.role) } };
						} catch (e) {
							console.error('[auth-sync] user.create.before failed:', msg(e));
						}
					},
					after: async (u) => {
						try {
							const role = normalizeAppRole((u as { role?: string | null }).role);
							const org = await ensureAppOrg(DEFAULT_ORG_ID);
							await ensureAuthOrgMirror(org);
							// Everyone joins the default workspace (single-workspace reality;
							// multi-org membership management is future work).
							await db
								.insert(schema.member)
								.values({
									id: `mem_${u.id}`,
									organizationId: org.id,
									userId: u.id,
									role: role === 'owner' || role === 'admin' ? role : 'member',
									createdAt: new Date()
								})
								.onConflictDoNothing();
							const inv = await findPendingInvitation(db, u.email);
							await syncAuthUserToApp(db, u, {
								role,
								// Only force the role onto an adopted (pre-existing) row when it
								// was explicitly derived: first-user owner or an invitation.
								adoptRole: role === 'owner' || Boolean(inv),
								orgId: org.id
							});
							if (inv) {
								await db
									.update(schema.invitation)
									.set({ status: 'accepted' })
									.where(eq(schema.invitation.id, inv.id));
							}
						} catch (e) {
							console.error('[auth-sync] user.create.after failed:', msg(e));
						}
					}
				},
				update: {
					after: async (u) => {
						try {
							const raw = (u as { role?: string | null }).role;
							await syncAuthUserToApp(
								db,
								u,
								raw ? { role: normalizeAppRole(raw), adoptRole: true } : {}
							);
						} catch (e) {
							console.error('[auth-sync] user.update.after failed:', msg(e));
						}
					}
				}
			},
			session: {
				create: {
					// Pin the session to the member's organization so org-scoped reads,
					// writes and audit rows resolve consistently (C10).
					before: async (s) => {
						try {
							if ((s as { activeOrganizationId?: string | null }).activeOrganizationId) return;
							const [m] = await db
								.select({ organizationId: schema.member.organizationId })
								.from(schema.member)
								.where(eq(schema.member.userId, s.userId))
								.limit(1);
							return { data: { ...s, activeOrganizationId: m?.organizationId ?? DEFAULT_ORG_ID } };
						} catch {
							/* keep better-auth defaults */
						}
					},
					// Sign-in bookkeeping: last_active_at on the app users row is real.
					after: async (s) => {
						try {
							const updated = await db
								.update(schema.users)
								.set({ lastActiveAt: new Date() })
								.where(eq(schema.users.id, s.userId))
								.returning({ id: schema.users.id });
							if (updated.length === 0) {
								// Adopted rows keep their original id — match by email instead.
								const [au] = await db
									.select({ email: schema.user.email })
									.from(schema.user)
									.where(eq(schema.user.id, s.userId))
									.limit(1);
								if (au) {
									await db
										.update(schema.users)
										.set({ lastActiveAt: new Date() })
										.where(sql`lower(${schema.users.email}) = ${au.email.toLowerCase()}`);
								}
							}
						} catch {
							/* bookkeeping only — never block session creation */
						}
					}
				}
			}
		},
		plugins: [
			organization({
				organizationHooks: {
					// Mirror every better-auth organization into the app table so
					// org-scoped FKs (audit_logs, org_settings, folders…) can reference it.
					afterCreateOrganization: async ({ organization: org }) => {
						try {
							const db2 = getDb();
							if (!db2) return;
							await insertAppOrg(db2, {
								id: org.id,
								name: org.name,
								slug: org.slug || org.id,
								tenantId: org.id
							});
							knownOrgs.set(org.id, { id: org.id, name: org.name, tenantId: org.id });
						} catch (e) {
							console.error('[auth-sync] organization mirror failed:', msg(e));
						}
					}
				}
			}),
			// 'owner' outranks 'admin' in the app RBAC — both may use admin endpoints
			// (set-user-password, revoke-user-sessions…). New users default to viewer.
			admin({ defaultRole: 'viewer', adminRoles: ['admin', 'owner'] }),
			bearer()
		]
	});
}

export const auth = process.env.DATABASE_URL ? build() : null;
