/**
 * S3/MinIO object storage helpers. process.env (not $env) so this loads in both
 * the SvelteKit server and the standalone ingestion worker.
 */

function isConfigured(): boolean {
	return Boolean(process.env.S3_ENDPOINT && process.env.S3_BUCKET && process.env.S3_ACCESS_KEY_ID);
}

async function client() {
	const { S3Client } = await import('@aws-sdk/client-s3');
	return new S3Client({
		endpoint: process.env.S3_ENDPOINT,
		region: process.env.S3_REGION ?? 'us-east-1',
		forcePathStyle: true, // required for MinIO
		credentials: {
			accessKeyId: process.env.S3_ACCESS_KEY_ID as string,
			secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? ''
		}
	});
}

/** Download an object's bytes. Returns null when storage isn't configured. */
export async function downloadObject(key: string): Promise<Uint8Array | null> {
	if (!isConfigured()) return null;
	const { GetObjectCommand } = await import('@aws-sdk/client-s3');
	const c = await client();
	const res = await c.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
	if (!res.Body) return null;
	return await res.Body.transformToByteArray();
}
