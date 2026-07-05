/**
 * Build a concept dictionary from a UMLS-style RRF file into the loader format.
 * Handles RxNorm (RXNCONSO.RRF) and UMLS/SNOMED (MRCONSO.RRF) — both are
 * pipe-delimited with CUI@0, LAT@1, ISPREF@6, SAB@11, TTY@12, STR@14, SUPPRESS@16.
 * Streamed line-by-line (bounded memory). UMLS/SNOMED are user-supplied only.
 *
 * Usage:
 *   tsx scripts/ontology/build-rrf.ts rxnorm ./RXNCONSO.RRF
 *   tsx scripts/ontology/build-rrf.ts snomed ./MRCONSO.RRF --sab SNOMEDCT_US
 * Then: pnpm db:ontology:load resources/ontologies/rxnorm.json
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';

async function main() {
	const args = process.argv.slice(2);
	const ontology = args[0];
	const file = args[1];
	const sabIdx = args.indexOf('--sab');
	const sabFilter = sabIdx >= 0 ? args[sabIdx + 1] : null;
	const outArg = args[2] && !args[2].startsWith('--') ? args[2] : undefined;
	if (!ontology || !file) {
		console.error('usage: build-rrf.ts <ontology> <RRF file> [out] [--sab SAB]');
		process.exit(1);
	}

	const map = new Map<string, { pref?: string; syns: Set<string> }>();
	const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
	let rows = 0;
	for await (const line of rl) {
		if (!line) continue;
		rows++;
		const f = line.split('|');
		const cui = f[0];
		const lat = f[1];
		const ispref = f[6];
		const sab = f[11];
		const str = f[14];
		const suppress = f[16];
		if (lat !== 'ENG' || suppress === 'Y' || suppress === 'O') continue;
		if (sabFilter && sab !== sabFilter) continue;
		if (!cui || !str) continue;
		let e = map.get(cui);
		if (!e) {
			e = { syns: new Set() };
			map.set(cui, e);
		}
		if (ispref === 'Y' && !e.pref) e.pref = str;
		if (e.syns.size < 40) e.syns.add(str);
	}

	const concepts: any[] = [];
	for (const [cui, e] of map) {
		const pref = e.pref ?? [...e.syns][0];
		if (!pref) continue;
		const synonyms = [...e.syns].filter((s) => s !== pref).slice(0, 25);
		concepts.push({ id: `${ontology}:${cui}`, ontology, code: cui, prefLabel: pref, kind: 'concept', synonyms });
	}

	const out = outArg ?? join('resources', 'ontologies', `${ontology}.json`);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, JSON.stringify({ concepts, edges: [] }, null, 2));
	console.log(`Parsed ${rows} rows → ${concepts.length} concepts → ${out}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
