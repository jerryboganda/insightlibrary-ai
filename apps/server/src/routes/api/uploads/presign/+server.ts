import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { env } from '$env/dynamic/private';

/**
 * Issue a presigned PUT URL so clients upload documents DIRECTLY to S3/MinIO.
 * Never proxy uploads through this server: adapter-node's BODY_SIZE_LIMIT
 * defaults to 512 KB and would reject real PDFs/ebooks.
 */
const presignSchema = z.object({
	filename: z.string().min(1),
	contentType: z.string().min(1),
	folderId: z.string()
});

export const POST: RequestHandler = async ({ request, locals }) => {
	const parsed = presignSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) throw error(400, 'Invalid presign request');

	if (!env.S3_ENDPOINT || !env.S3_BUCKET || !env.S3_ACCESS_KEY_ID) {
		throw error(503, 'Object storage is not configured (set S3_* env). Run docker-compose for MinIO.');
	}

	const { S3Client } = await import('@aws-sdk/client-s3');
	const { PutObjectCommand } = await import('@aws-sdk/client-s3');
	const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

	const client = new S3Client({
		// Sign against the browser-reachable endpoint (S3_PUBLIC_ENDPOINT) so the
		// client can PUT directly; the worker downloads via the internal S3_ENDPOINT.
		endpoint: env.S3_PUBLIC_ENDPOINT || env.S3_ENDPOINT,
		region: env.S3_REGION ?? 'us-east-1',
		forcePathStyle: true,
		credentials: {
			accessKeyId: env.S3_ACCESS_KEY_ID,
			secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? ''
		}
	});

	const tenant = locals.user?.tenantId ?? 'public';
	const key = `${tenant}/${parsed.data.folderId}/${Date.now()}-${parsed.data.filename}`;
	const url = await getSignedUrl(
		client,
		new PutObjectCommand({
			Bucket: env.S3_BUCKET,
			Key: key,
			ContentType: parsed.data.contentType
		}),
		{ expiresIn: 900 }
	);

	return json({ url, key, method: 'PUT' });
};
