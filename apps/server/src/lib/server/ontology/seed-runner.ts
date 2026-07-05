import { seedOntology } from './load';

seedOntology()
	.then((r) => {
		console.log('Ontology seeded:', r);
		process.exit(0);
	})
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
