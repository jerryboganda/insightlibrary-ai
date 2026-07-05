import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * Proxy the OAuth token exchange for the desktop "Sign in with ChatGPT" flow
 * (avoids browser CORS on the OpenAI token endpoint). Two grants:
 *
 *  - authorization_code (default): the desktop app runs PKCE, captures the code
 *    via a loopback listener, and posts { code, verifier, redirectUri, clientId }.
 *  - refresh_token: posts { grantType: 'refresh_token', refreshToken, clientId }
 *    to renew an expiring access token (see apps/app platform/oauth.ts).
 *
 * Tokens are returned to the desktop client, which stores them in the OS
 * keyring — nothing is persisted server-side. EXPERIMENTAL / off-label
 * (consumer ChatGPT subscription).
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as {
		grantType?: string;
		code?: string;
		verifier?: string;
		redirectUri?: string;
		clientId?: string;
		refreshToken?: string;
	} | null;

	const grant = body?.grantType === 'refresh_token' ? 'refresh_token' : 'authorization_code';
	let params: URLSearchParams;
	if (grant === 'refresh_token') {
		if (!body?.refreshToken || !body.clientId) {
			throw error(400, 'refreshToken and clientId are required for the refresh_token grant');
		}
		params = new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: body.refreshToken,
			client_id: body.clientId
		});
	} else {
		if (!body?.code || !body.verifier || !body.redirectUri || !body.clientId) {
			throw error(400, 'code, verifier, redirectUri and clientId are required');
		}
		params = new URLSearchParams({
			grant_type: 'authorization_code',
			code: body.code,
			redirect_uri: body.redirectUri,
			client_id: body.clientId,
			code_verifier: body.verifier
		});
	}

	const tokenUrl = process.env.CHATGPT_OAUTH_TOKEN_URL ?? 'https://auth.openai.com/oauth/token';
	const res = await fetch(tokenUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: params
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw error(502, `OAuth token exchange failed (${res.status}): ${detail.slice(0, 200)}`);
	}
	return json(await res.json());
};
