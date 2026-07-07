//! System-scoped settings (`/api/admin/system-settings`), super-admin only.
//! Pricing, queue tuning, rate limits, auth TTLs, pipeline caps. Includes a
//! read-only block of sidecar env that needs a restart to change.

use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::auth::RequireSuperAdmin;
use crate::error::ApiError;
use crate::state::AppState;
use insight_core::settings::{self, Scope};

/// Env-driven, restart-required config (inference/parser sidecars) surfaced for
/// display only — changing these means redeploying those services.
fn restart_required() -> Value {
    fn env_or(key: &str, default: &str) -> String {
        std::env::var(key).unwrap_or_else(|_| default.to_string())
    }
    json!({
        "inferenceDenseModel": env_or("INFER_DENSE_MODEL", "bge-base-en-v1.5"),
        "inferenceDenseDim": 768,
        "inferenceSparseModel": env_or("INFER_SPARSE_MODEL", "splade"),
        "inferenceRerankModel": env_or("INFER_RERANK_MODEL", "ms-marco-MiniLM"),
        "parserSvcUrl": env_or("PARSER_SVC_URL", "http://parser-svc:8000"),
        "inferenceSvcUrl": env_or("INFERENCE_SVC_URL", "http://inference-svc:8000"),
    })
}

/// `GET /api/admin/system-settings` (super-admin).
pub async fn get_system_settings(
    State(state): State<AppState>,
    _su: RequireSuperAdmin,
) -> Result<Json<Value>, ApiError> {
    let settings = state.stores.settings.resolve_system().await?;
    Ok(Json(json!({
        "settings": settings,
        "defaults": settings::scope_defaults(Scope::System),
        "restartRequired": restart_required(),
    })))
}

/// `PUT /api/admin/system-settings` (super-admin). Body is a partial patch.
pub async fn update_system_settings(
    State(state): State<AppState>,
    RequireSuperAdmin(user): RequireSuperAdmin,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let patch = settings::whitelist_patch(Scope::System, body);
    let settings = state
        .stores
        .settings
        .patch_system(&patch, Some(user.user_id))
        .await?;
    Ok(Json(json!({
        "settings": settings,
        "defaults": settings::scope_defaults(Scope::System),
        "restartRequired": restart_required(),
    })))
}
