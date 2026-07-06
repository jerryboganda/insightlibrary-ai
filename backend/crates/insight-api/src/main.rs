//! insight-api — axum REST/WebSocket server. Thin shell over insight-core:
//! boot + router wiring live here, everything else in the sibling modules.

mod auth;
mod error;
mod middleware;
mod routes;
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
        .route("/api/uploads/presign", post(routes::documents::presign))
        .route(
            "/api/documents",
            post(routes::documents::create_document).get(routes::documents::list_documents),
        )
        .route("/api/documents/{id}", get(routes::documents::get_document))
        .route("/api/jobs/{id}", get(routes::jobs::get_job))
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
