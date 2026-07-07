//! Per-user UI preferences. `GET` returns the raw stored blob (not merged with
//! defaults, matching the Node contract); `PATCH` replaces the whole blob.

use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::auth::AuthedUser;
use crate::error::ApiError;
use crate::state::AppState;

/// `GET /api/preferences` → `{ prefs }`.
pub async fn get_preferences(
    State(state): State<AppState>,
    user: AuthedUser,
) -> Result<Json<Value>, ApiError> {
    let prefs = state
        .stores
        .settings
        .user_prefs_raw(user.tenant_id, user.user_id)
        .await?;
    Ok(Json(json!({ "prefs": prefs })))
}

/// `PATCH /api/preferences` — body is the entire prefs object; stored whole.
pub async fn patch_preferences(
    State(state): State<AppState>,
    user: AuthedUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let obj = if body.is_object() { body } else { json!({}) };
    state
        .stores
        .settings
        .set_user_prefs_raw(user.tenant_id, user.user_id, &obj)
        .await?;
    Ok(Json(json!({ "ok": true })))
}
