/**
 * Load a prebuilt ontology JSON (loader format) into the DB.
 *   tsx src/lib/server/ontology/load-runner.ts resources/ontologies/mondo.json
 */
import { readFileSync } from 'node:fs';
import { loadOntology, type OntologyData } from './load';

const path = process.argv[2];
if (!path) {
	console.error('usage: load-runner.ts <path-to-ontology.json>');
	process.exit(1);
}

loadOntology(JSON.parse(readFileSync(path, 'utf8')) as OntologyData)
	.then((r) => {
		console.log('Loaded ontology:', r);
		process.exit(0);
	})
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
