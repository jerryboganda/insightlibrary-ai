/**
 * Real document text extraction — no simulation. PDF via unpdf (pure-JS pdf.js,
 * no native deps), EPUB by unzipping and stripping XHTML, everything else as
 * UTF-8 text. Runs in the ingestion worker after the file is pulled from S3.
 */
export async function extractText(bytes: Uint8Array, filename: string): Promise<string> {
	const lower = filename.toLowerCase();

	if (lower.endsWith('.pdf')) {
		const { extractText: pdfExtract, getDocumentProxy } = await import('unpdf');
		const pdf = await getDocumentProxy(bytes);
		// mergePages:true → `text` is a single joined string.
		const { text } = await pdfExtract(pdf, { mergePages: true });
		return text;
	}

	if (lower.endsWith('.epub')) {
		const JSZip = (await import('jszip')).default;
		const zip = await JSZip.loadAsync(bytes);
		const htmlFiles = Object.keys(zip.files)
			.filter((f) => /\.(x?html?)$/i.test(f))
			.sort();
		let out = '';
		for (const f of htmlFiles) {
			const raw = await zip.files[f].async('string');
			out += raw.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ') + '\n';
		}
		return out;
	}

	// txt / md / docx-as-text and other formats: best-effort UTF-8 decode.
	return new TextDecoder().decode(bytes);
}
