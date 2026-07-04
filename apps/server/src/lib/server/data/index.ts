import { env } from '$env/dynamic/private';
import type { Repository } from './repository';
import { InMemoryRepository } from './repository';
import { PostgresRepository } from './postgres';
import {
	seedAudit,
	seedCoverage,
	seedDelta,
	seedDocuments,
	seedEvaluation,
	seedFlashcards,
	seedFolders,
	seedGraph,
	seedNotifications,
	seedOntologies,
	seedProcessing,
	seedReview,
	seedSources,
	seedTopics,
	seedUsage,
	seedUsers
} from './seed';

export type { Repository } from './repository';

let instance: Repository | null = null;

/**
 * Resolve the singleton repository. Postgres when DATABASE_URL is set, otherwise
 * an in-memory repo seeded from the prototype dataset — so the entire app runs
 * with zero external services during development.
 */
export function getRepository(): Repository {
	if (instance) return instance;

	if (env.DATABASE_URL) {
		// pg Pool is only constructed here, so the in-memory path stays inert.
		instance = new PostgresRepository(env.DATABASE_URL);
	} else {
		instance = new InMemoryRepository({
			folders: structuredClone(seedFolders),
			documents: structuredClone(seedDocuments),
			sources: structuredClone(seedSources),
			topics: structuredClone(seedTopics),
			coverage: structuredClone(seedCoverage),
			delta: structuredClone(seedDelta),
			flashcards: structuredClone(seedFlashcards),
			graph: structuredClone(seedGraph),
			review: structuredClone(seedReview),
			usage: structuredClone(seedUsage),
			evaluation: structuredClone(seedEvaluation),
			processing: structuredClone(seedProcessing),
			audit: structuredClone(seedAudit),
			ontologies: structuredClone(seedOntologies),
			users: structuredClone(seedUsers),
			notifications: structuredClone(seedNotifications)
		});
	}

	return instance;
}
