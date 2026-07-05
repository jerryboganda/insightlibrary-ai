import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface GoldenItem {
	id: string;
	query: string;
	/** A substring that a correct retrieval / citation should surface. */
	expect: string;
}

const GOLDEN_PATH = join(dirname(fileURLToPath(import.meta.url)), 'golden', 'medical-v1.jsonl');

export function loadGolden(): GoldenItem[] {
	const raw = readFileSync(GOLDEN_PATH, 'utf8');
	return raw
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => JSON.parse(l) as GoldenItem);
}
