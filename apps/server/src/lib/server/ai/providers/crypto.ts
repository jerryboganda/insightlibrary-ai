/**
 * AES-256-GCM at-rest encryption for stored provider API keys.
 *
 * Keys entered by users in the web app (no OS keyring available) are stored in
 * Postgres encrypted with a server-held MASTER_ENCRYPTION_KEY (32 bytes, hex or
 * base64). Desktop keys never reach here — they live in the OS keyring.
 *
 * Format: base64( iv[12] || authTag[16] || ciphertext ), prefixed "v1:".
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { getEnv } from './config';

const PREFIX = 'v1:';

function masterKey(): Buffer | null {
	const raw = getEnv('MASTER_ENCRYPTION_KEY');
	if (!raw) return null;
	let buf: Buffer;
	if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, 'hex');
	else buf = Buffer.from(raw, 'base64');
	if (buf.length !== 32) {
		throw new Error('MASTER_ENCRYPTION_KEY must decode to 32 bytes (hex-64 or base64-44)');
	}
	return buf;
}

export function encryptionAvailable(): boolean {
	return !!getEnv('MASTER_ENCRYPTION_KEY');
}

export function encryptSecret(plain: string): string {
	const key = masterKey();
	if (!key) throw new Error('MASTER_ENCRYPTION_KEY not set — cannot store API keys server-side');
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptSecret(enc: string): string {
	const key = masterKey();
	if (!key) throw new Error('MASTER_ENCRYPTION_KEY not set — cannot read stored API keys');
	if (!enc.startsWith(PREFIX)) throw new Error('unrecognized ciphertext format');
	const buf = Buffer.from(enc.slice(PREFIX.length), 'base64');
	const iv = buf.subarray(0, 12);
	const tag = buf.subarray(12, 28);
	const ct = buf.subarray(28);
	const decipher = createDecipheriv('aes-256-gcm', key, iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Non-reversible fingerprint so the UI can show "key ending in …ab12" safely. */
export function keyHint(plain: string): string {
	const tail = plain.slice(-4);
	return `••••${tail}`;
}
