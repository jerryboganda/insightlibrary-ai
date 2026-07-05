/**
 * S3/MinIO object storage helpers. process.env (not $env) so this loads in both
 * the SvelteKit server and the standalone ingestion worker.
 */

export function isStorageConfigured(): boolean {
	return isConfigured();
}

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

/**
 * Presign a browser-reachable GET URL for an object. Signed against
 * S3_PUBLIC_ENDPOINT when set (internal S3_ENDPOINT otherwise — the same
 * convention the upload presign route uses, which assumes S3_ENDPOINT is
 * client-reachable when no public endpoint is configured). Returns null when
 * storage isn't configured.
 */
export async function presignGetUrl(
	key: string,
	opts: { filename?: string; expiresIn?: number } = {}
): Promise<string | null> {
	if (!isConfigured()) return null;
	const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
	const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
	const c = new S3Client({
		endpoint: process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT,
		region: process.env.S3_REGION ?? 'us-east-1',
		forcePathStyle: true,
		credentials: {
			accessKeyId: process.env.S3_ACCESS_KEY_ID as string,
			secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? ''
		}
	});
	// RFC 6266: quote + strip characters that would break the header.
	const safeName = opts.filename?.replace(/["\\\r\n]/g, '_');
	return getSignedUrl(
		c,
		new GetObjectCommand({
			Bucket: process.env.S3_BUCKET,
			Key: key,
			...(safeName ? { ResponseContentDisposition: `inline; filename="${safeName}"` } : {})
		}),
		{ expiresIn: opts.expiresIn ?? 900 }
	);
}

export interface BucketUsage {
	bytes: number;
	objects: number;
	/** True when ListObjectsV2 stopped early (very large prefixes) — bytes is a floor. */
	truncated: boolean;
	cachedAt: string;
}

// ListObjectsV2 walks every object, so cache per prefix for ~5 minutes.
const USAGE_TTL_MS = 5 * 60 * 1000;
const usageCache = new Map<string, { at: number; value: BucketUsage }>();

/**
 * Aggregate object count + size under a key prefix (org/tenant usage).
 * Cached ~5 min per prefix. Returns null when storage isn't configured.
 */
export async function bucketUsage(prefix: string): Promise<BucketUsage | null> {
	if (!isConfigured()) return null;
	const hit = usageCache.get(prefix);
	if (hit && Date.now() - hit.at < USAGE_TTL_MS) return hit.value;

	const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
	const c = await client();
	let bytes = 0;
	let objects = 0;
	let token: string | undefined;
	let pages = 0;
	let truncated = false;
	do {
		const res = await c.send(
			new ListObjectsV2Command({
				Bucket: process.env.S3_BUCKET,
				Prefix: prefix,
				ContinuationToken: token
			})
		);
		for (const obj of res.Contents ?? []) {
			bytes += obj.Size ?? 0;
			objects += 1;
		}
		token = res.IsTruncated ? res.NextContinuationToken : undefined;
		pages += 1;
		// Safety valve: 100 pages = 100k objects; beyond that report a floor
		// rather than hammering the store on every cache refresh.
		if (pages >= 100 && token) {
			truncated = true;
			token = undefined;
		}
	} while (token);

	const value: BucketUsage = { bytes, objects, truncated, cachedAt: new Date().toISOString() };
	usageCache.set(prefix, { at: Date.now(), value });
	return value;
}
