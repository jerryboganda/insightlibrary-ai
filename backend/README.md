# insight-library

Server-authoritative engine for Insight Library AI. Rust modular monolith run two ways
(`insight-api` + `insight-worker`, both linking `insight-core`) plus two side services
(`parser-svc` Docling, `inference-svc` embeddings/rerank/whisper). Data plane:
Postgres 16 + pgvector, Valkey, MinIO. Single-VPS Docker Compose deployment behind a
dedicated Cloudflare Tunnel (project name `insight`).

The Svelte 5 frontend lives in the sibling `insightlibrary/` monorepo (`apps/app`) and
talks to `insight-api` over HTTPS/WS/SSE.

## Layout

- `crates/insight-core` — the brain: tenancy, storage, ingest, retrieve, ontology, graph,
  synth, study, tutor, llm, export, collab, analytics, billing, eval
- `crates/insight-api` — axum REST/WS/SSE server
- `crates/insight-worker` — job-queue worker (Redis Streams via apalis)
- `services/parser-svc` — FastAPI + Docling: file → canonical JSON (+ thumbnails)
- `services/inference-svc` — FastAPI: dense/sparse embeddings, rerank, STT (CPU/ONNX)
- `deploy/` — docker-compose.yml (project `insight`), Caddyfile (internal router),
  cloudflared config, deploy scripts

## Dev loop

- Local (Windows): `cargo build --workspace && cargo clippy --workspace --all-targets`
  (pure unit tests run locally; `SQLX_OFFLINE=true` once sqlx lands).
- Deploy: `git push vps main` (bare repo on the VPS checks out to `/opt/insight/app`),
  then `deploy/scripts/deploy.ps1` or
  `ssh root@185.252.233.186 'cd /opt/insight/app && docker compose --env-file .env -f deploy/docker-compose.yml -p insight up -d --build'`.
- All integration/acceptance tests run on the VPS against the compose stack.

## Guardrails

The VPS is shared with unrelated production projects. Never publish host ports; the only
ingress is the dedicated `cloudflared` service. Never touch the live `insightlibrary-*`
containers, pm2 apps, or `cloudflared-insightai.service`.
