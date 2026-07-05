/**
 * Admin-manageable golden evaluation set (gap C8).
 *
 * The golden set was a fixed bundled file (golden.ts → golden/medical-v1.jsonl).
 * This module makes it a per-org, DB-backed, editable set:
 *  - `golden_items` is defined here (migration 0014) because db/schema.ts is not
 *    owned by this lane — Drizzle's query builder works with any pgTable object.
 *    Fold into db/schema.ts later (see followUp).
 *  - On first read for an org with no stored items, the bundled set is seeded so
 *    nothing regresses (existing behavior preserved).
 *  - runGoldenEval reads the DB set via loadGoldenSet(), falling back to the
 *    bundled file only when the table is empty / the DB is unavailable.
 *
 * Worker/route safe: getDb() only, never throws for a missing table.
 */
import { and, asc, eq } from 'drizzle-orm';
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { getDb } from '../db/client';
import { loadGolden, type GoldenItem } from './golden';

/** Per-org golden eval items. `source`: 'seed' (from the bundle) | 'custom'. */
export const goldenItems = pgTable('golden_items', {
	id: text('id').primaryKey(),
	orgId: text('org_id').notNull(),
	query: text('query').notNull(),
	expect: text('expect').notNull(),
	source: text('source').notNull().default('custom'),
	createdAt: timestamp('created_at').notNull().defaultNow(),
	updatedAt: timestamp('updated_at').notNull().defaultNow()
});

export interface GoldenRecord extends GoldenItem {
	orgId: string;
	source: 'seed' | 'custom';
	createdAt: string;
	updatedAt: string;
}

let seq = 0;
function nextId(orgId: string): string {
	seq = (seq + 1) % 1_000_000;
	return `gi_${orgId}_${Date.now().toString(36)}_${seq.toString(36)}`;
}

function toRecord(r: typeof goldenItems.$inferSelect): GoldenRecord {
	return {
		id: r.id,
		query: r.query,
		expect: r.expect,
		orgId: r.orgId,
		source: r.source === 'seed' ? 'seed' : 'custom',
		createdAt: r.createdAt.toISOString(),
		updatedAt: r.updatedAt.toISOString()
	};
}

/**
 * Seed the bundled golden set for an org the first time it is read (idempotent:
 * skipped once any row exists). Best-effort — returns false and leaves the DB
 * untouched on any failure so callers fall back to the bundled file.
 */
async function seedIfEmpty(orgId: string): Promise<boolean> {
	const db = getDb();
	if (!db) return false;
	try {
		const existing = await db.select({ id: goldenItems.id }).from(goldenItems).where(eq(goldenItems.orgId, orgId)).limit(1);
		if (existing.length > 0) return true;
		const bundled = loadGolden();
		if (bundled.length === 0) return true;
		const now = new Date();
		await db
			.insert(goldenItems)
			.values(
				bundled.map((g) => ({
					// Stable id so a re-seed after a manual wipe cannot duplicate rows.
					id: `gi_seed_${orgId}_${g.id}`,
					orgId,
					query: g.query,
					expect: g.expect,
					source: 'seed',
					createdAt: now,
					updatedAt: now
				}))
			)
			.onConflictDoNothing();
		return true;
	} catch (e) {
		console.error('[golden-store] seed failed:', e instanceof Error ? e.message : e);
		return false;
	}
}

/**
 * Full golden set an org's evaluation runs against: DB items (seeded from the
 * bundle on first use), or the bundled file when the DB is unavailable/empty.
 */
export async function loadGoldenSet(orgId = 'org_1'): Promise<GoldenItem[]> {
	const db = getDb();
	if (!db) return loadGolden();
	try {
		await seedIfEmpty(orgId);
		const rows = await db
			.select()
			.from(goldenItems)
			.where(eq(goldenItems.orgId, orgId))
			.orderBy(asc(goldenItems.createdAt));
		if (rows.length === 0) return loadGolden();
		return rows.map((r) => ({ id: r.id, query: r.query, expect: r.expect }));
	} catch (e) {
		console.error('[golden-store] load failed, using bundled set:', e instanceof Error ? e.message : e);
		return loadGolden();
	}
}

/** Admin list (with metadata) for the management UI. Seeds on first read. */
export async function listGoldenItems(orgId = 'org_1'): Promise<GoldenRecord[]> {
	const db = getDb();
	if (!db) {
		return loadGolden().map((g) => ({
			...g,
			orgId,
			source: 'seed' as const,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString()
		}));
	}
	await seedIfEmpty(orgId);
	const rows = await db
		.select()
		.from(goldenItems)
		.where(eq(goldenItems.orgId, orgId))
		.orderBy(asc(goldenItems.createdAt));
	return rows.map(toRecord);
}

export async function createGoldenItem(orgId: string, input: { query: string; expect: string }): Promise<GoldenRecord> {
	const db = getDb();
	if (!db) throw new Error('Database required to add golden items');
	await seedIfEmpty(orgId);
	const now = new Date();
	const [row] = await db
		.insert(goldenItems)
		.values({
			id: nextId(orgId),
			orgId,
			query: input.query.trim(),
			expect: input.expect.trim(),
			source: 'custom',
			createdAt: now,
			updatedAt: now
		})
		.returning();
	return toRecord(row);
}

export async function updateGoldenItem(
	orgId: string,
	id: string,
	patch: { query?: string; expect?: string }
): Promise<GoldenRecord | null> {
	const db = getDb();
	if (!db) throw new Error('Database required to edit golden items');
	const set: Partial<typeof goldenItems.$inferInsert> = { updatedAt: new Date() };
	if (patch.query !== undefined) set.query = patch.query.trim();
	if (patch.expect !== undefined) set.expect = patch.expect.trim();
	const [row] = await db
		.update(goldenItems)
		.set(set)
		.where(and(eq(goldenItems.orgId, orgId), eq(goldenItems.id, id)))
		.returning();
	return row ? toRecord(row) : null;
}

export async function deleteGoldenItem(orgId: string, id: string): Promise<boolean> {
	const db = getDb();
	if (!db) throw new Error('Database required to remove golden items');
	const rows = await db
		.delete(goldenItems)
		.where(and(eq(goldenItems.orgId, orgId), eq(goldenItems.id, id)))
		.returning({ id: goldenItems.id });
	return rows.length > 0;
}
