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

## Phase 2 — Actions -> VPS SSH deploy
- Generate a dedicated ed25519 deploy key; append pubkey to VPS `root@185.252.233.186:~/.ssh/authorized_keys`;
  store private key as GitHub secret `VPS_SSH_KEY` (+ `VPS_HOST`, `VPS_USER`).
- `deploy.yml`: on push to main -> rsync repo to `/opt/insight/app` (EXCLUDE `.env*`, `.git`, `node_modules`,
  `target`, model caches — preserve live secrets on the box) -> ssh `cd /opt/insight/app/backend &&
  docker compose --env-file .env -f deploy/docker-compose.yml -p insight up -d --build --remove-orphans`.
- Blast radius contained by `-p insight` + no host ports. Never touch other stacks' containers.

## Guardrails
Shared VPS. Never publish host ports; only ingress = the `insight` cloudflared tunnel.
Never touch live `insightlibrary-*` containers / pm2 apps / `cloudflared-insightai.service`.
