//! insight-api — axum REST/WebSocket server. Thin shell over insight-core:
//! boot + router wiring live here, everything else in the sibling modules.

mod auth;
mod error;
mod middleware;
mod routes;
mod sse;
mod state;
mod ws;

use std::sync::Arc;

use anyhow::Context;
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE};
use axum::http::{HeaderName, HeaderValue, Method};
use axum::routing::{get, post};
use axum::Router;
use insight_core::storage::{self, JobQueue, StorageConfig, Stores};
use tower_http::cors::CorsLayer;

use crate::state::{ApiConfig, AppState};

fn cors_layer(cfg: &ApiConfig) -> CorsLayer {
    let origins: Vec<HeaderValue> = cfg
        .cors_origins
        .iter()
        .filter_map(|o| o.parse().ok())
        .collect();
    CorsLayer::new()
        .allow_origin(origins)
        .allow_credentials(true)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            AUTHORIZATION,
            CONTENT_TYPE,
            HeaderName::from_static("idempotency-key"),
        ])
        .expose_headers([HeaderName::from_static("idempotency-replayed")])
}

fn router(state: AppState) -> Router {
    // Health probes: no rate limiting (by construction, not by allowlist).
    let public = Router::new()
        .route("/healthz", get(routes::health::healthz))
        .route("/readyz", get(routes::health::readyz))
        .route("/api/health", get(routes::health::api_health));

    // Anonymous auth endpoints: IP-keyed limiter (the tenant-keyed one is
    // useless pre-auth), throttling credential brute-force and the argon2
    // CPU/memory-exhaustion DoS.
    let auth = Router::new()
        .route("/api/auth/sign-up", post(routes::auth::sign_up))
        .route("/api/auth/sign-in", post(routes::auth::sign_in))
        .route("/api/auth/refresh", post(routes::auth::refresh))
        .route("/api/auth/sign-out", post(routes::auth::sign_out))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            middleware::auth_rate_limit,
        ));

    let protected = Router::new()
        .route("/api/session", get(routes::auth::session))
        // Alias listed in docs/frontend-api-surface.md (better-auth path the
        // existing client probes).
        .route("/api/auth/session", get(routes::auth::session))
        // Device sessions (settings page).
        .route("/api/auth/sessions", get(routes::auth::list_sessions))
        .route(
            "/api/auth/sessions/revoke",
            post(routes::auth::revoke_session),
        )
        .route(
            "/api/auth/sessions/revoke-others",
            post(routes::auth::revoke_other_sessions),
        )
        .route("/api/uploads/presign", post(routes::documents::presign))
        .route(
            "/api/documents",
            post(routes::documents::create_document).get(routes::documents::list_documents),
        )
        .route("/api/documents/{id}", get(routes::documents::get_document))
        .route(
            "/api/documents/{id}/download",
            get(routes::documents::download_document),
        )
        .route(
            "/api/documents/{id}/structure",
            get(routes::documents::document_structure),
        )
        .route(
            "/api/search",
            get(routes::search::search_get).post(routes::search::search_post),
        )
        .route("/api/jobs/{id}", get(routes::jobs::get_job))
        // Library: folders + sources + figures.
        .route(
            "/api/folders",
            get(routes::folders::list_folders).post(routes::folders::create_folder),
        )
        .route("/api/folders/{id}", get(routes::folders::get_folder))
        .route(
            "/api/sources",
            get(routes::sources::list_sources).post(routes::sources::create_source),
        )
        .route(
            "/api/sources/{id}",
            axum::routing::patch(routes::sources::update_source),
        )
        .route("/api/figures", get(routes::figures::search_figures))
        // Processing pipeline monitor.
        .route("/api/processing", get(routes::processing::list_processing))
        .route(
            "/api/processing/stats",
            get(routes::processing::processing_stats),
        )
        .route(
            "/api/processing/stream",
            get(routes::processing::processing_stream),
        )
        .route(
            "/api/processing/{id}/cancel",
            post(routes::processing::cancel_job),
        )
        .route(
            "/api/processing/{id}/retry",
            post(routes::processing::retry_job),
        )
        // Admin ops.
        .route("/api/admin/reindex", post(routes::admin::reindex))
        .route(
            "/api/admin/storage-stats",
            get(routes::admin::storage_stats),
        )
        // Topics / SSOT.
        .route("/api/topics", get(routes::topics::list_topics))
        .route("/api/topics/{id}", get(routes::topics::get_topic))
        .route(
            "/api/topics/{id}/claims",
            get(routes::topics::get_topic_claims).post(routes::topics::add_claim),
        )
        .route(
            "/api/topics/{id}/verify",
            post(routes::topics::verify_topic),
        )
        .route(
            "/api/topics/{id}/regenerate",
            post(routes::topics::regenerate_topic),
        )
        .route(
            "/api/topics/{id}/versions",
            get(routes::topics::list_versions),
        )
        .route(
            "/api/topics/{id}/versions/{version}/restore",
            post(routes::topics::restore_version),
        )
        .route("/api/topics/{id}/case", post(routes::topics::generate_case))
        .route(
            "/api/topics/{id}/flashcards",
            post(routes::topics::generate_flashcards),
        )
        // Knowledge graph.
        .route("/api/graph", get(routes::graph::get_graph))
        .route(
            "/api/graph/communities",
            get(routes::graph::get_communities),
        )
        .route(
            "/api/graph/community/{nodeId}",
            get(routes::graph::get_community),
        )
        .route("/api/graph/pagerank", get(routes::graph::get_pagerank))
        .route("/api/graph/stats", get(routes::graph::get_stats))
        // Review queue.
        .route("/api/review", get(routes::review::list_review))
        .route("/api/review/{id}", post(routes::review::resolve_review))
        // Preferences (per-user).
        .route(
            "/api/preferences",
            get(routes::preferences::get_preferences).patch(routes::preferences::patch_preferences),
        )
        // Org settings (GET any member; PUT admin-gated in the handler).
        .route(
            "/api/org/settings",
            get(routes::org_settings::get_org_settings)
                .put(routes::org_settings::update_org_settings),
        )
        // User administration (admin-gated in the handlers).
        .route(
            "/api/users",
            get(routes::users::list_users).post(routes::users::users_action),
        )
        .route(
            "/api/users/{id}",
            axum::routing::patch(routes::users::update_user).post(routes::users::user_id_action),
        )
        // System settings (super-admin-gated in the handlers).
        .route(
            "/api/admin/system-settings",
            get(routes::admin_settings::get_system_settings)
                .put(routes::admin_settings::update_system_settings),
        )
        // Multi-provider AI settings + BYO keys + usage.
        .route(
            "/api/ai/providers",
            get(routes::ai::get_providers).put(routes::ai::set_providers),
        )
        .route(
            "/api/ai/keys",
            post(routes::ai::save_key).delete(routes::ai::delete_key),
        )
        .route("/api/usage", get(routes::usage::get_usage))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            middleware::rate_limit,
        ));

    let realtime = Router::new()
        .route("/realtime", get(ws::realtime))
        .route("/api/realtime", get(ws::realtime));

    // Span with path only — NO query string: /realtime accepts the access
    // JWT as `?token=`, which must never reach the logs.
    let trace = tower_http::trace::TraceLayer::new_for_http().make_span_with(
        |req: &axum::http::Request<axum::body::Body>| {
            tracing::info_span!(
                "request",
                method = %req.method(),
                path = %req.uri().path(),
            )
        },
    );

    Router::new()
        .merge(public)
        .merge(auth)
        .merge(protected)
        .merge(realtime)
        .layer(cors_layer(&state.cfg))
        .layer(trace)
        .with_state(state)
}

async fn init_state() -> anyhow::Result<AppState> {
    let cfg = ApiConfig::from_env().context("reading api config")?;
    let storage_cfg = StorageConfig::from_env().context("reading storage config")?;
    let stores = Stores::connect(storage_cfg).await?;
    storage::run_migrations(&stores.pool).await?;
    let queue = JobQueue::connect(stores.pool.clone(), &stores.config.redis_url).await?;
    tracing::info!("storage connected and migrations applied");
    Ok(AppState {
        stores: Arc::new(stores),
        queue: Arc::new(queue),
        cfg: Arc::new(cfg),
    })
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .json()
        .init();

    let state = init_state().await?;

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, version = insight_core::VERSION, "insight-api listening");
    // connect-info feeds the IP-keyed auth rate limiter when no
    // X-Forwarded-For header is present (direct/local access).
    axum::serve(
        listener,
        router(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn api_health_shape() {
        let body = crate::routes::health::api_health().await.0;
        assert_eq!(body["status"], "ok");
        assert_eq!(body["service"], "insight-api");
        assert_eq!(body["dataSource"], "postgres");
        assert!(body["time"].is_string());
    }

    #[tokio::test]
    async fn healthz_returns_ok() {
        let body = crate::routes::health::healthz().await.0;
        assert_eq!(body["status"], "ok");
    }
}
