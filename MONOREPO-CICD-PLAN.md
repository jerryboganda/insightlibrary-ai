# Monorepo + GitHub-Actions CI/CD plan

Decisions (2026-07-07): single monorepo on `github.com/jerryboganda/insightlibrary-ai`;
production deploy = GitHub Actions SSHes into the shared VPS on push to `main`.

## Target repo layout
```
insightlibrary-ai/            (existing GitHub repo, was the Svelte/Node monorepo)
  .github/workflows/
    ci.yml        # lightweight: web typecheck + rust fmt/clippy/test + compose validate
    deploy.yml    # push-to-main -> rsync to VPS -> docker compose up -d --build (project `insight`)
  apps/app        # Svelte 5 frontend (KEPT)
  apps/desktop    # Tauri shell
  apps/server     # OLD Node server (Rust replaces it; retire later, left for now)
  packages/       # shared JS (api-client, schemas, ui)
  backend/        # Rust engine (was standalone insight-library/): crates + services + deploy
  docker-compose.yml  # old Node local-infra (obsolete; kept for now)
```

## Phase 1 — merge + lightweight CI  (safe, on GitHub)
- Snapshot-merge Rust `insight-library/` -> `backend/` via `git archive` (tracked files only).
- Replace heavy CI (3-OS Tauri desktop matrix) with one fast `ci.yml`.
- Commit + push to `main`. CI runs on GitHub.

## Phase 2 — Actions builds -> GHCR -> VPS pulls  (NO build on the VPS)
Build is compute-intensive (Rust compile) and MUST run on GitHub runners, never the
shared prod box. The VPS only pulls prebuilt images and restarts.
- `build` job: compile + push 4 images to GHCR — `ghcr.io/jerryboganda/insight-{api,
  worker,parser-svc,inference-svc}`, tags `:latest` + `:<sha>`, GHA layer cache.
  api+worker share one cargo-chef compile (same Dockerfile.rust builder stage).
- `deploy` job: rsync `backend/deploy/` -> `/opt/insight/app/deploy/` (no `--delete`;
  exclude live cloudflared creds) then on the VPS: `docker login ghcr` (run token) ->
  `compose.sh pull` the 4 by `<sha>` -> `compose.sh up -d --no-build --remove-orphans`
  with `IMAGE_TAG=<sha>`. `--no-build` guarantees the box never compiles.
- Auth: dedicated ed25519 deploy key in GitHub secret `VPS_SSH_KEY` (pubkey in VPS
  `root@...:~/.ssh/authorized_keys`). compose services carry `image: ...:${IMAGE_TAG:-latest}`
  (build: kept for local dev). Blast radius contained by `-p insight` + no host ports.

## Guardrails
Shared VPS. Never publish host ports; only ingress = the `insight` cloudflared tunnel.
Never touch live `insightlibrary-*` containers / pm2 apps / `cloudflared-insightai.service`.
