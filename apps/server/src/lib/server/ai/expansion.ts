/**
 * Query expansion for the topic-recall audit — expands a surface term into all
 * ontology aliases + neighbor labels so retrieval for a topic uses every name
 * ("Addison", "primary adrenal insufficiency", "adrenal crisis", …), not just
 * the surface form. Thin wrapper over the ontology linker.
 */
import { expandAliases } from '../ontology/link';

export async function expandQuery(query: string): Promise<string[]> {
	try {
		const aliases = await expandAliases(query);
		return aliases.length ? aliases : [query];
	} catch {
		return [query];
	}
}
