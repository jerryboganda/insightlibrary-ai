import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * Proxy the OAuth authorization-code → token exchange (avoids browser CORS on
 * the OpenAI token endpoint). The desktop app runs the PKCE flow, captures the
 * code via a loopback listener, and posts { code, verifier, redirectUri, clientId }
 * here. Tokens are returned to the desktop client, which stores them in the OS
 * keyring. EXPERIMENTAL / off-label (consumer ChatGPT subscription).
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as {
		code?: string;
		verifier?: string;
		redirectUri?: string;
		clientId?: string;
	} | null;
	if (!body?.code || !body.verifier || !body.redirectUri || !body.clientId) {
		throw error(400, 'code, verifier, redirectUri and clientId are required');
	}

	const tokenUrl = process.env.CHATGPT_OAUTH_TOKEN_URL ?? 'https://auth.openai.com/oauth/token';
	const res = await fetch(tokenUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code: body.code,
			redirect_uri: body.redirectUri,
			client_id: body.clientId,
			code_verifier: body.verifier
		})
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw error(502, `OAuth token exchange failed (${res.status}): ${detail.slice(0, 200)}`);
	}
	return json(await res.json());
};
