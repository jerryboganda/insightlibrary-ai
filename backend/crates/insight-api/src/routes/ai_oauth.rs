//! Desktop "Sign in with ChatGPT" OAuth token-exchange proxy, ported from the
//! retired Node backend (`apps/server/.../api/ai-oauth/exchange`). It exists to
//! dodge browser CORS on OpenAI's token endpoint. Two grants:
//!
//!  - `authorization_code` (default): the desktop app runs PKCE, captures the
//!    code via a loopback listener, and posts `{ code, verifier, redirectUri,
//!    clientId }`.
//!  - `refresh_token`: posts `{ grantType: "refresh_token", refreshToken,
//!    clientId }` to renew an expiring access token.
//!
//! Tokens are returned straight to the desktop client (which stores them in the
//! OS keyring); nothing is persisted server-side. EXPERIMENTAL / off-label
//! (consumer ChatGPT subscription). Mounted on the IP-rate-limited anonymous
//! router: the caller authenticates to OpenAI via PKCE, not to us, and the
//! proxy only ever forwards to the single hard-coded OpenAI token endpoint.

use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::Value;

use crate::error::ApiError;

/// OpenAI's OAuth token endpoint (overridable for tests / self-host).
const DEFAULT_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeBody {
    grant_type: Option<String>,
    code: Option<String>,
    verifier: Option<String>,
    redirect_uri: Option<String>,
    client_id: Option<String>,
    refresh_token: Option<String>,
}

fn gateway_error(msg: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::BAD_GATEWAY, "bad_gateway", msg)
}

/// `POST /api/ai-oauth/exchange` — proxy the OAuth token exchange to OpenAI and
/// return its `{ access_token, refresh_token, expires_in }` verbatim.
pub async fn exchange(Json(body): Json<ExchangeBody>) -> Result<Json<Value>, ApiError> {
    let nonempty = |v: Option<String>| v.filter(|s| !s.is_empty());
    let form: Vec<(&'static str, String)> = if body.grant_type.as_deref() == Some("refresh_token") {
        let (Some(refresh_token), Some(client_id)) =
            (nonempty(body.refresh_token), nonempty(body.client_id))
        else {
            return Err(ApiError::bad_request(
                "refreshToken and clientId are required for the refresh_token grant",
            ));
        };
        vec![
            ("grant_type", "refresh_token".to_string()),
            ("refresh_token", refresh_token),
            ("client_id", client_id),
        ]
    } else {
        let (Some(code), Some(verifier), Some(redirect_uri), Some(client_id)) = (
            nonempty(body.code),
            nonempty(body.verifier),
            nonempty(body.redirect_uri),
            nonempty(body.client_id),
        ) else {
            return Err(ApiError::bad_request(
                "code, verifier, redirectUri and clientId are required",
            ));
        };
        vec![
            ("grant_type", "authorization_code".to_string()),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("client_id", client_id),
            ("code_verifier", verifier),
        ]
    };

    let token_url =
        std::env::var("CHATGPT_OAUTH_TOKEN_URL").unwrap_or_else(|_| DEFAULT_TOKEN_URL.to_string());

    let res = reqwest::Client::new()
        .post(&token_url)
        .form(&form)
        .send()
        .await
        .map_err(|e| gateway_error(format!("OAuth token exchange request failed: {e}")))?;

    let status = res.status();
    if !status.is_success() {
        let detail: String = res
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(200)
            .collect();
        return Err(gateway_error(format!(
            "OAuth token exchange failed ({status}): {detail}"
        )));
    }
    let tokens: Value = res
        .json()
        .await
        .map_err(|e| gateway_error(format!("OAuth token exchange returned invalid JSON: {e}")))?;
    Ok(Json(tokens))
}
