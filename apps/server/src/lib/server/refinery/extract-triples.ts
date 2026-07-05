/**
 * LightRAG-style triple extraction: turn a document's claims into
 * (subject, relation, object) triples and upsert them into the semantic
 * knowledge graph (graph_nodes/graph_edges). Nodes are deduped by slug so the
 * graph stays small and incremental.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { claims, graphEdges, graphNodes } from '../db/schema';
import { getRouter } from '../ai/providers';

const TRIPLE_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		triples: {
			type: 'array',
			items: {
				type: 'object',
				properties: { subject: { type: 'string' }, relation: { type: 'string' }, object: { type: 'string' } },
				required: ['subject', 'relation', 'object']
			}
		}
	},
	required: ['triples']
};

function slug(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}
const nodeId = (name: string) => `n_${slug(name)}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function upsertNode(db: any, orgId: string, name: string): Promise<string> {
	const id = nodeId(name);
	await db
		.insert(graphNodes)
		.values({ id, orgId, group: 'concept', size: 12, kind: 'concept', label: name })
		.onConflictDoNothing();
	return id;
}

export async function extractTriplesForDocument(documentId: string, orgId: string): Promise<{ triples: number }> {
	const db = getDb();
	if (!db) return { triples: 0 };
	const router = getRouter();
	if (!router.available('extraction')) return { triples: 0 };

	const rows = await db
		.select()
		.from(claims)
		.where(and(eq(claims.documentId, documentId), eq(claims.orgId, orgId)));
	if (!rows.length) return { triples: 0 };

	const text = rows
		.slice(0, 80)
		.map((c, i) => `${i + 1}. ${c.claimText}`)
		.join('\n');
	const res = await router
		.json<{ triples: { subject: string; relation: string; object: string }[] }>(
			[
				{
					role: 'user',
					content:
						'From these medical claims, extract (subject, relation, object) triples for a knowledge graph. ' +
						'Use concise canonical entity names. Return JSON {"triples":[...]}.\n\n' +
						text
				}
			],
			{ task: 'extraction', schema: TRIPLE_SCHEMA, temperature: 0 }
		)
		.catch(() => null);
	if (!res?.triples?.length) return { triples: 0 };

	let n = 0;
	for (const tr of res.triples) {
		if (!tr.subject?.trim() || !tr.object?.trim() || !tr.relation?.trim()) continue;
		const sId = await upsertNode(db, orgId, tr.subject.trim());
		const oId = await upsertNode(db, orgId, tr.object.trim());
		await db
			.insert(graphEdges)
			.values({
				id: `ge_${sId}__${slug(tr.relation)}__${oId}`,
				orgId,
				source: sId,
				target: oId,
				label: tr.relation.trim(),
				rel: tr.relation.trim(),
				weight: 1
			})
			.onConflictDoNothing();
		n++;
	}
	return { triples: n };
}
