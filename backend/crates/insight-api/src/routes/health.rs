//! Liveness/readiness (`/healthz`, `/readyz` — compose healthchecks) and the
//! frontend-facing `GET /api/health`.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use crate::state::AppState;

/// `GET /api/health` — shape required by the existing Svelte frontend.
pub async fn api_health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "service": "insight-api",
        "version": insight_core::VERSION,
        "dataSource": "postgres",
        // use_z: the frontend schema (z.iso.datetime()) rejects `+00:00`.
        "time": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    }))
}

/// `GET /healthz` — pure liveness, no backend probes.
pub async fn healthz() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "service": "insight-api",
        "version": insight_core::VERSION,
    }))
}

/// `GET /readyz` — probes Postgres/Redis/MinIO. Coarse per-backend status
/// only; raw error chains (internal hostnames) go to the server log.
pub async fn readyz(State(state): State<AppState>) -> (StatusCode, Json<Value>) {
    let health = state.stores.health().await;
    fn coarse(name: &str, err: &Option<String>) -> &'static str {
        match err {
            None => "ok",
            Some(e) => {
                tracing::warn!(backend = name, error = %e, "readiness probe failed");
                "error"
            }
        }
    }
    let body = json!({
        "status": if health.healthy() { "ready" } else { "unavailable" },
        "postgres": coarse("postgres", &health.postgres),
        "redis": coarse("redis", &health.redis),
        "object_store": coarse("object_store", &health.object_store),
    });
    let code = if health.healthy() {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (code, Json(body))
}
