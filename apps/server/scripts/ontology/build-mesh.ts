/**
 * Build the MeSH concept dictionary from the NLM descriptor XML (desc20XX.xml)
 * into the loader format. Streams the file and processes one <DescriptorRecord>
 * at a time (bounded memory — no XML lib / no full in-memory DOM). MeSH is
 * freely redistributable.
 *
 * Usage:
 *   tsx scripts/ontology/build-mesh.ts ./desc2026.xml
 * Then: pnpm db:ontology:load resources/ontologies/mesh.json
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function decode(s: string): string {
	return s
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.trim();
}

function processRecord(rec: string, concepts: any[]): void {
	const ui = /<DescriptorUI>(.*?)<\/DescriptorUI>/.exec(rec)?.[1];
	const name = /<DescriptorName>\s*<String>([\s\S]*?)<\/String>/.exec(rec)?.[1];
	if (!ui || !name) return;
	const prefLabel = decode(name);
	const terms = [...rec.matchAll(/<Term\b[\s\S]*?<String>([\s\S]*?)<\/String>/g)].map((t) => decode(t[1]));
	const synonyms = [...new Set(terms)].filter((t) => t && t !== prefLabel).slice(0, 30);
	concepts.push({ id: `mesh:${ui}`, ontology: 'mesh', code: ui, prefLabel, kind: 'concept', synonyms });
}

async function main() {
	const [file, outArg] = process.argv.slice(2);
	if (!file) {
		console.error('usage: build-mesh.ts <desc20XX.xml> [out]');
		process.exit(1);
	}
	const concepts: any[] = [];
	let buffer = '';
	const RECORD = /<DescriptorRecord[\s\S]*?<\/DescriptorRecord>/g;

	await new Promise<void>((resolve, reject) => {
		const stream = createReadStream(file, { encoding: 'utf8' });
		stream.on('data', (chunk) => {
			buffer += chunk;
			RECORD.lastIndex = 0;
			let lastEnd = 0;
			let m: RegExpExecArray | null;
			while ((m = RECORD.exec(buffer))) {
				processRecord(m[0], concepts);
				lastEnd = m.index + m[0].length;
			}
			if (lastEnd > 0) buffer = buffer.slice(lastEnd);
		});
		stream.on('end', () => resolve());
		stream.on('error', reject);
	});

	const out = outArg ?? join('resources', 'ontologies', 'mesh.json');
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, JSON.stringify({ concepts, edges: [] }, null, 2));
	console.log(`Parsed ${concepts.length} MeSH descriptors → ${out}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
