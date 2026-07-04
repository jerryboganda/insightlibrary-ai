import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.ts';
import {
	seedAudit,
	seedDocuments,
	seedFolders,
	seedGraph,
	seedNotifications,
	seedOntologies,
	seedOrg,
	seedProcessing,
	seedReview,
	seedSources,
	seedTopics,
	seedUsage,
	seedUsers
} from '../data/seed.ts';

/**
 * Seed a fresh Postgres database with the prototype dataset.
 *   DATABASE_URL=... pnpm --filter @insightlibrary/server db:seed
 * Run after `db:push` creates the schema.
 */
async function main() {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error('DATABASE_URL is required to seed Postgres');
	const pool = new pg.Pool({ connectionString: url });
	const db = drizzle(pool, { schema });
	const org = seedOrg.id;

	await db.insert(schema.organizations).values(seedOrg).onConflictDoNothing();

	await db.insert(schema.users).values(
		seedUsers.map((u) => ({
			id: u.id,
			orgId: org,
			name: u.name,
			email: u.email,
			role: u.role,
			initials: u.initials
		}))
	).onConflictDoNothing();

	await db.insert(schema.folders).values(
		seedFolders.map((f) => ({ id: f.id, orgId: org, name: f.name, health: f.health }))
	).onConflictDoNothing();

	await db.insert(schema.documents).values(
		seedDocuments.map((d) => ({
			id: d.id,
			folderId: d.folderId,
			title: d.title,
			status: d.status,
			statusLabel: d.statusLabel,
			type: d.type,
			pages: d.pages
		}))
	).onConflictDoNothing();

	await db.insert(schema.sources).values(
		seedSources.map((s) => ({ id: s.id, orgId: org, name: s.name, author: s.author, type: s.type, priority: s.priority, date: s.date }))
	).onConflictDoNothing();

	await db.insert(schema.topics).values(
		seedTopics.map((t) => ({
			id: t.id,
			orgId: org,
			name: t.name,
			aliases: t.aliases,
			health: t.health,
			updates: t.updates,
			folder: t.folder,
			sections: t.sections ?? []
		}))
	).onConflictDoNothing();

	await db.insert(schema.reviewItems).values(
		seedReview.map((r) => ({ ...r, orgId: org }))
	).onConflictDoNothing();

	await db.insert(schema.graphNodes).values(
		seedGraph.nodes.map((n) => ({ id: n.id, orgId: org, group: n.group, size: n.size }))
	).onConflictDoNothing();

	await db.insert(schema.graphEdges).values(
		seedGraph.edges.map((e, i) => ({ id: `edge_${i}`, orgId: org, source: e.source, target: e.target, label: e.label }))
	).onConflictDoNothing();

	await db.insert(schema.processingJobs).values(
		seedProcessing.map((p) => ({ id: p.id, documentId: p.documentId, documentTitle: p.documentTitle, stage: p.stage, progress: p.progress, message: p.message }))
	).onConflictDoNothing();

	await db.insert(schema.auditLogs).values(
		seedAudit.map((a) => ({ id: a.id, orgId: org, actor: a.actor, action: a.action, target: a.target, severity: a.severity }))
	).onConflictDoNothing();

	await db.insert(schema.ontologies).values(
		seedOntologies.map((o) => ({ id: o.id, orgId: org, name: o.name, entities: o.entities, relations: o.relations, status: o.status }))
	).onConflictDoNothing();

	await db.insert(schema.notifications).values(
		seedNotifications.map((n) => ({ id: n.id, orgId: org, type: n.type, title: n.title, description: n.description, action: n.action, read: n.read }))
	).onConflictDoNothing();

	await db.insert(schema.usageMetrics).values({
		orgId: org,
		monthlyBudget: seedUsage.monthlyBudget,
		currentSpend: seedUsage.currentSpend,
		queries: seedUsage.queries,
		costPerQuery: seedUsage.costPerQuery,
		activeUsers: seedUsage.activeUsers,
		storageGb: seedUsage.storageGB,
		events: seedUsage.events
	}).onConflictDoNothing();

	// Full-text search: a generated tsvector column + GIN index on chunks. Paired
	// with pgvector for the hybrid RRF search in postgres.ts. Idempotent.
	await pool.query(
		`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS content_fts tsvector
		 GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;`
	);
	await pool.query(`CREATE INDEX IF NOT EXISTS chunks_content_fts_idx ON chunks USING gin(content_fts);`);

	// Seed searchable chunks from the SSOT claims so hybrid search returns real
	// hits immediately (embeddings are filled in later by the ingestion worker).
	const chunkRows = seedTopics.flatMap((t) =>
		(t.sections ?? []).flatMap((s) =>
			s.claims.map((c) => ({
				id: `${t.id}_${s.id}_${c.id}`,
				documentId: 'doc1',
				page: null,
				content: c.content,
				embedding: null
			}))
		)
	);
	if (chunkRows.length) await db.insert(schema.chunks).values(chunkRows).onConflictDoNothing();

	console.info(`✔ seeded Postgres with prototype dataset (${chunkRows.length} searchable chunks)`);
	await pool.end();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
