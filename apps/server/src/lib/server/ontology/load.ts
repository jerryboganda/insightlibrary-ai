/**
 * Ontology loader. Inserts concepts + synonyms + edges and precomputes one
 * embedding per label/synonym (concept_embeddings) for entity linking.
 *
 * The bundled seed (resources/ontologies/seed.json) covers the vertical slice.
 * Full MeSH/Mondo/HPO/RxNorm are produced by scripts/ontology/build-*.ts, which
 * download the (freely redistributable) releases and emit this same shape. UMLS/
 * SNOMED are user-supplied only (never bundled — license line).
 * Worker-safe (process.env via getDb()).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../db/client';
import { conceptEdges, conceptEmbeddings, conceptSynonyms, concepts } from '../db/schema';
import { embedText } from '../ai/embeddings';

export interface ConceptRecord {
	id: string;
	ontology: string;
	code: string;
	prefLabel: string;
	kind?: string;
	description?: string;
	synonyms?: string[];
}
export interface OntologyEdge {
	source: string;
	target: string;
	rel: string;
	weight?: number;
}
export interface OntologyData {
	concepts: ConceptRecord[];
	edges?: OntologyEdge[];
}

export async function loadOntology(
	data: OntologyData
): Promise<{ concepts: number; synonyms: number; edges: number; embeddings: number }> {
	const db = getDb();
	if (!db) throw new Error('DATABASE_URL required to load an ontology');
	let synCount = 0;
	let embCount = 0;

	for (const c of data.concepts) {
		await db
			.insert(concepts)
			.values({ id: c.id, ontology: c.ontology, code: c.code, prefLabel: c.prefLabel, kind: c.kind ?? 'concept', description: c.description ?? '' })
			.onConflictDoNothing();

		const labels = [c.prefLabel, ...(c.synonyms ?? [])];
		for (let i = 0; i < labels.length; i++) {
			const label = labels[i];
			if (i > 0) {
				await db
					.insert(conceptSynonyms)
					.values({ id: `syn_${c.id}_${i}`, conceptId: c.id, synonym: label })
					.onConflictDoNothing();
				synCount++;
			}
			const emb = await embedText(label).catch(() => null);
			await db
				.insert(conceptEmbeddings)
				.values({ id: `ce_${c.id}_${i}`, conceptId: c.id, label, embedding: emb })
				.onConflictDoNothing();
			embCount++;
		}
	}

	let edgeCount = 0;
	for (const e of data.edges ?? []) {
		await db
			.insert(conceptEdges)
			.values({ id: `edge_${e.source}__${e.rel}__${e.target}`, sourceConceptId: e.source, targetConceptId: e.target, rel: e.rel, weight: e.weight ?? 1 })
			.onConflictDoNothing();
		edgeCount++;
	}

	return { concepts: data.concepts.length, synonyms: synCount, edges: edgeCount, embeddings: embCount };
}

const SEED_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'resources', 'ontologies', 'seed.json');

/** Load the bundled seed ontology. */
export async function seedOntology(): Promise<{ concepts: number; synonyms: number; edges: number; embeddings: number }> {
	const data = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as OntologyData;
	return loadOntology(data);
}
