//! Multi-provider AI settings: the provider registry + org routing (admin) and
//! BYO key management (admin for org scope; any member for their own user
//! scope). Shapes match the api-client (`AiProvidersResponse`,
//! `AiProviderSettingsInput`, `AiKeyInput`).

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::{AuthedUser, RequireAdmin};
use crate::error::ApiError;
use crate::state::AppState;
use insight_core::llm;

/// `GET /api/ai/providers` — registry + effective routing + embeddings health.
pub async fn get_providers(
    State(state): State<AppState>,
    user: AuthedUser,
) -> Result<Json<Value>, ApiError> {
    let cfg = state.stores.settings.resolve_org(user.tenant_id).await?;
    let ai = &cfg["ai"];
    let stored = llm::list_provider_keys(&state.stores, user.tenant_id).await?;

    let key_stored = |p: &str| stored.iter().any(|k| k.provider == p);
    let key_hint = |p: &str| {
        stored
            .iter()
            .find(|k| k.provider == p)
            .and_then(|k| k.key_hint.clone())
            .unwrap_or_default()
    };

    let providers: Vec<Value> = llm::KNOWN_PROVIDERS
        .iter()
        .map(|&p| {
            let model = ai["models"][p].as_str().filter(|s| !s.is_empty());
            json!({
                "id": p,
                "label": llm::provider_label(p),
                "kind": llm::provider_kind(p),
                "envConfigured": llm::env_configured(p),
                "keyStored": key_stored(p),
                "hint": key_hint(p),
                "model": model,
                "supportsEmbeddings": llm::provider_supports_embeddings(p),
            })
        })
        .collect();

    let task_routing = ai["taskRouting"].clone();
    let active_chat = task_routing["chat"]
        .as_str()
        .unwrap_or("gemini")
        .to_string();

    // Embeddings health: an org/env key for gemini (768-dim path) or openai.
    let (emb_configured, emb_provider, emb_source) = if key_stored("gemini") {
        (true, Some("gemini"), Some("stored"))
    } else if llm::env_configured("gemini") {
        (true, Some("gemini"), Some("env"))
    } else if key_stored("openai") {
        (true, Some("openai"), Some("stored"))
    } else if llm::env_configured("openai") {
        (true, Some("openai"), Some("env"))
    } else {
        (false, None, None)
    };

    Ok(Json(json!({
        "providers": providers,
        "activeChatProvider": active_chat,
        "encryptionAvailable": llm::encryption_available(),
        "defaultProvider": task_routing["chat"].as_str(),
        "taskRouting": task_routing,
        "taskProviders": task_routing,
        "embeddings": {
            "configured": emb_configured,
            "provider": emb_provider,
            "source": emb_source,
        },
    })))
}

// Body keys arrive camelCase from the client.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettingsBody {
    #[serde(default)]
    default_provider: Option<Option<String>>,
    #[serde(default)]
    task_routing: Option<std::collections::HashMap<String, String>>,
}

/// `PUT /api/ai/providers` (admin) — set org default provider + task routing.
pub async fn set_providers(
    State(state): State<AppState>,
    RequireAdmin(user): RequireAdmin,
    Json(body): Json<ProviderSettingsBody>,
) -> Result<Json<Value>, ApiError> {
    let mut patch = serde_json::Map::new();
    let mut ai_patch = serde_json::Map::new();

    if let Some(routing) = &body.task_routing {
        for prov in routing.values() {
            if insight_core::llm::ProviderId::from_str(prov).is_none() {
                return Err(ApiError::bad_request(format!("unknown provider '{prov}'")));
            }
        }
        ai_patch.insert("taskRouting".into(), json!(routing));
    }
    // Default provider is modeled as the chat task route.
    if let Some(Some(p)) = &body.default_provider {
        if insight_core::llm::ProviderId::from_str(p).is_none() {
            return Err(ApiError::bad_request(format!("unknown provider '{p}'")));
        }
        let tr = ai_patch
            .entry("taskRouting".to_string())
            .or_insert_with(|| json!({}));
        if let Some(map) = tr.as_object_mut() {
            map.insert("chat".into(), json!(p));
        }
    }

    if !ai_patch.is_empty() {
        patch.insert("ai".into(), Value::Object(ai_patch));
    }
    let bundle = state
        .stores
        .settings
        .patch_org(user.tenant_id, &Value::Object(patch), None, None)
        .await?;
    let routing = bundle.settings["ai"]["taskRouting"].clone();
    Ok(Json(json!({
        "ok": true,
        "defaultProvider": routing["chat"].as_str(),
        "taskRouting": routing,
    })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyBody {
    provider: String,
    api_key: String,
    base_url: Option<String>,
    model: Option<String>,
    #[serde(default = "default_scope")]
    scope: String,
}
fn default_scope() -> String {
    "org".into()
}

/// `POST /api/ai/keys` — store a BYO key. Org scope requires admin; user scope
/// is self-service. baseUrl/model (when given) update org routing config.
pub async fn save_key(
    State(state): State<AppState>,
    user: AuthedUser,
    Json(body): Json<KeyBody>,
) -> Result<Json<Value>, ApiError> {
    if !llm::known_provider(&body.provider) {
        return Err(ApiError::bad_request("unknown provider"));
    }
    if body.api_key.trim().is_empty() {
        return Err(ApiError::bad_request("apiKey is required"));
    }
    if body.scope == "org"
        && insight_core::tenancy::role_rank(&user.role) < insight_core::tenancy::role_rank("admin")
    {
        return Err(ApiError::forbidden("org keys require admin"));
    }
    if !llm::encryption_available() {
        return Err(ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "encryption_unavailable",
            "PROVIDER_KEY_KEK is not configured; cannot store keys",
        ));
    }

    llm::store_provider_key(
        &state.stores,
        user.tenant_id,
        user.user_id,
        &body.provider,
        &body.scope,
        body.api_key.trim(),
    )
    .await?;

    // Persist baseUrl/model into org settings so routing uses them.
    if body.base_url.is_some() || body.model.is_some() {
        let mut ai = serde_json::Map::new();
        if let Some(base) = &body.base_url {
            if body.provider == "openai-compatible" {
                ai.insert("baseUrls".into(), json!({ "openaiCompatible": base }));
            }
        }
        if let Some(model) = &body.model {
            ai.insert("models".into(), json!({ &body.provider: model }));
        }
        if !ai.is_empty() {
            state
                .stores
                .settings
                .patch_org(user.tenant_id, &json!({ "ai": ai }), None, None)
                .await?;
        }
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
pub struct DeleteKeyQuery {
    provider: String,
    #[serde(default = "default_scope")]
    scope: String,
}

/// `DELETE /api/ai/keys?provider=&scope=` — remove a BYO key.
pub async fn delete_key(
    State(state): State<AppState>,
    user: AuthedUser,
    Query(q): Query<DeleteKeyQuery>,
) -> Result<Json<Value>, ApiError> {
    if q.scope == "org"
        && insight_core::tenancy::role_rank(&user.role) < insight_core::tenancy::role_rank("admin")
    {
        return Err(ApiError::forbidden("org keys require admin"));
    }
    llm::delete_provider_key(
        &state.stores,
        user.tenant_id,
        user.user_id,
        &q.provider,
        &q.scope,
    )
    .await?;
    Ok(Json(json!({ "ok": true })))
}
