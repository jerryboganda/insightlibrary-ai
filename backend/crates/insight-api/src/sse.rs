//! Server-Sent Events helpers shared by the processing stream (Phase 9) and the
//! copilot stream (Phase 11).
//!
//! EventSource clients cannot set an `Authorization` header, so these endpoints
//! accept the access token from the `insight_access` cookie OR an
//! `?access_token=` query param (the trace layer logs paths only, never query
//! strings — see main.rs).

use axum::http::HeaderMap;

use crate::auth::{self, AuthedUser};
use crate::error::ApiError;
use crate::state::AppState;

/// Resolve the caller for an SSE endpoint from a `?access_token=` query param
/// (Tauri path) or the access cookie / bearer header (web path).
pub fn authed_for_sse(
    state: &AppState,
    headers: &HeaderMap,
    access_token: Option<&str>,
) -> Result<AuthedUser, ApiError> {
    if let Some(token) = access_token.filter(|t| !t.is_empty()) {
        let claims = auth::verify(&state.cfg, token, "access")?;
        return Ok(AuthedUser {
            user_id: claims.sub,
            tenant_id: claims.ten,
            role: claims.role,
            session_id: claims.sid,
        });
    }
    AuthedUser::maybe(headers, &state.cfg)
        .ok_or_else(|| ApiError::unauthorized("missing credentials"))
}

/// Subscribe to a Redis pub/sub channel and stream each message as an SSE
/// `data:` event. The stream ends when the pub/sub connection closes.
pub async fn subscribe_stream(
    redis_url: &str,
    channel: String,
) -> anyhow::Result<
    impl futures::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
> {
    use futures::StreamExt;
    let client = redis::Client::open(redis_url)?;
    let mut pubsub = client.get_async_pubsub().await?;
    pubsub.subscribe(&channel).await?;
    let stream = pubsub.into_on_message().map(|msg| {
        let payload: String = msg.get_payload().unwrap_or_default();
        Ok(axum::response::sse::Event::default().data(payload))
    });
    Ok(stream)
}
