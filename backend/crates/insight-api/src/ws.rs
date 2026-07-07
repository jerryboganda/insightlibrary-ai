//! `GET /realtime` (alias `/api/realtime`) — WebSocket fan-out of Redis
//! pub/sub events.
//!
//! Auth: `insight_access` cookie OR `?token=<access-jwt>` (browsers cannot
//! set WS headers; the trace layer logs paths only, never query strings).
//! Each connection gets a dedicated pub/sub connection subscribed to
//! `user:{user_id}`; every published message is forwarded as one text frame.
//! Clients may send `{ "type": "subscribe", "channel": "topic:{id}" |
//! "workspace:{id}" }` to widen the subscription. Every widening is
//! authorized: the id must resolve to a row owned by the caller's tenant
//! (checked under the RLS tenant context), and the actual Redis channel is
//! namespaced as `tenant:{tenant_id}:{channel}` so a guessed or leaked id
//! from another tenant can never match a channel that tenant's events are
//! published on. Phase 4 publishers must publish topic/workspace events on
//! the tenant-namespaced channel names.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::{self, AuthedUser};
use crate::error::ApiError;
use crate::state::AppState;
use insight_core::storage::set_tenant;

#[derive(Debug, Deserialize)]
pub struct WsQuery {
    token: Option<String>,
}

pub async fn realtime(
    ws: WebSocketUpgrade,
    Query(query): Query<WsQuery>,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    // Query-param token first (Tauri/browser WS path), then cookie.
    let user = match query.token.as_deref() {
        Some(token) => {
            let claims = auth::verify(&state.cfg, token, "access")?;
            AuthedUser {
                user_id: claims.sub,
                tenant_id: claims.ten,
                role: claims.role,
                session_id: claims.sid,
            }
        }
        None => AuthedUser::maybe(&headers, &state.cfg)
            .ok_or_else(|| ApiError::unauthorized("missing credentials"))?,
    };

    Ok(ws.on_upgrade(move |socket| async move {
        if let Err(e) = pump(socket, state, user).await {
            tracing::debug!(error = format!("{e:#}"), "realtime connection ended");
        }
    }))
}

/// Forward pub/sub messages to the socket until either side closes.
async fn pump(socket: WebSocket, state: AppState, user: AuthedUser) -> anyhow::Result<()> {
    let client = redis::Client::open(state.stores.config.redis_url.as_str())?;
    let pubsub = client.get_async_pubsub().await?;
    let (mut redis_sink, mut redis_stream) = pubsub.split();
    redis_sink
        .subscribe(format!("user:{}", user.user_id))
        .await?;

    let (mut ws_tx, mut ws_rx) = socket.split();

    loop {
        tokio::select! {
            msg = redis_stream.next() => {
                let Some(msg) = msg else { break };
                let payload: String = msg.get_payload()?;
                if ws_tx.send(Message::Text(payload.into())).await.is_err() {
                    break;
                }
            }
            frame = ws_rx.next() => {
                match frame {
                    Some(Ok(Message::Text(text))) => {
                        handle_client_message(&state, &user, &mut redis_sink, &text).await;
                    }
                    Some(Ok(Message::Ping(data))) => {
                        if ws_tx.send(Message::Pong(data)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }

    // Drop cleanly; close frames are best-effort.
    let _ = ws_tx.close().await;
    Ok(())
}

#[derive(Debug, Deserialize)]
struct ClientMessage {
    #[serde(rename = "type")]
    kind: String,
    channel: Option<String>,
}

/// `true` when `channel` names a topic/workspace row the caller's tenant
/// owns. Resolved under the RLS tenant context, so another tenant's id
/// (guessed or leaked) is simply invisible.
async fn owns_channel(state: &AppState, tenant_id: Uuid, channel: &str) -> anyhow::Result<bool> {
    let Some((kind, id)) = channel.split_once(':') else {
        return Ok(false);
    };
    let table = match kind {
        "topic" => "topics",
        "workspace" => "workspaces",
        _ => return Ok(false),
    };
    let Ok(id) = id.parse::<Uuid>() else {
        return Ok(false);
    };
    let mut tx = state.stores.pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    let sql = format!("SELECT count(*) FROM {table} WHERE id = $1");
    let count: i64 = sqlx::query_scalar(&sql)
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(count > 0)
}

async fn handle_client_message(
    state: &AppState,
    user: &AuthedUser,
    sink: &mut redis::aio::PubSubSink,
    text: &str,
) {
    let Ok(msg) = serde_json::from_str::<ClientMessage>(text) else {
        return;
    };
    if msg.kind != "subscribe" {
        return;
    }
    let Some(channel) = msg.channel else { return };
    match owns_channel(state, user.tenant_id, &channel).await {
        Ok(true) => {}
        Ok(false) => {
            tracing::debug!(channel, tenant = %user.tenant_id, "subscribe denied");
            return;
        }
        Err(e) => {
            tracing::warn!(
                error = format!("{e:#}"),
                channel,
                "subscribe ownership check failed"
            );
            return;
        }
    }
    // Tenant-namespaced so cross-tenant channel names can never collide.
    let redis_channel = format!("tenant:{}:{channel}", user.tenant_id);
    if let Err(e) = sink.subscribe(&redis_channel).await {
        tracing::debug!(error = %e, channel, "extra subscribe failed");
    }
}
