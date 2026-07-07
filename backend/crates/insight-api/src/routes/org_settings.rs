//! Org-scoped settings (`/api/org/settings`). GET is any member; PUT is admin.
//! Response shape matches `OrgSettingsResponse` in the api-client:
//! `{ name, logo, settings, defaults, overridden, copilotPromptDefaults, updatedAt }`.

use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};

use crate::auth::{AuthedUser, RequireAdmin};
use crate::error::ApiError;
use crate::state::AppState;
use insight_core::settings::{self, OrgBundle, Scope};

fn bundle_to_response(b: &OrgBundle) -> Value {
    json!({
        "name": b.name,
        "logo": b.logo_key,
        "settings": b.settings,
        "defaults": b.defaults,
        "overridden": b.overridden,
        // Built-in copilot mode prompts land in Phase 11; empty until then.
        "copilotPromptDefaults": {},
        "updatedAt": b.updated_at,
    })
}

/// `GET /api/org/settings`.
pub async fn get_org_settings(
    State(state): State<AppState>,
    user: AuthedUser,
) -> Result<Json<Value>, ApiError> {
    let bundle = state.stores.settings.org_bundle(user.tenant_id).await?;
    Ok(Json(bundle_to_response(&bundle)))
}

/// Distinguish an absent field (leave unchanged) from an explicit `null`
/// (clear). `Option<Option<T>>` alone can't — serde folds a present null into
/// `None`, so wrap deserialization to always yield `Some(..)` when present.
fn double_option<'de, D, T>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Some(Option::deserialize(de)?))
}

#[derive(Debug, Default, Deserialize)]
pub struct UpdateBody {
    name: Option<String>,
    /// Absent = unchanged, `null` = clear, string = set.
    #[serde(default, deserialize_with = "double_option")]
    logo: Option<Option<String>>,
    /// Partial governance patch; each value may be `null` to clear back to the
    /// code/env default.
    settings: Option<Value>,
}

/// `PUT /api/org/settings` (admin).
pub async fn update_org_settings(
    State(state): State<AppState>,
    RequireAdmin(user): RequireAdmin,
    Json(body): Json<UpdateBody>,
) -> Result<Json<Value>, ApiError> {
    // Only accept keys that exist in the org defaults (drop arbitrary JSONB).
    let patch = settings::whitelist_patch(Scope::Org, body.settings.unwrap_or_else(|| json!({})));
    let name = body
        .name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty());
    let bundle = state
        .stores
        .settings
        .patch_org(user.tenant_id, &patch, name, body.logo)
        .await?;
    Ok(Json(bundle_to_response(&bundle)))
}
