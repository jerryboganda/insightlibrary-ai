export type BlockKind = 'text' | 'heading' | 'list' | 'table' | 'figure' | 'caption';

export interface ParsedBlock {
	kind: BlockKind;
	page: number;
	readingOrder: number;
	content: string;
	bbox?: [number, number, number, number] | null;
	confidence: number;
}

export interface ParsedPage {
	pageNo: number;
	width?: number | null;
	height?: number | null;
}

export interface ParsedDoc {
	pages: ParsedPage[];
	blocks: ParsedBlock[];
	/** Full reading-order text (compatibility with the text-only path). */
	text: string;
}
