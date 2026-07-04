# InsightLibrary AI

Enterprise knowledge-management platform for ebooks, PDFs, textbooks, study & research libraries — turn scattered books into one living, citation-backed single source of truth.

**One Svelte 5 UI codebase, three delivery targets:** desktop + mobile (Tauri 2) and browser (static SPA), backed by a SvelteKit API server.

## Architecture

```
apps/
  app/        SvelteKit 2 + Svelte 5 UI — single codebase for desktop, mobile, and web
              adapter-static SPA (ssr=false, index.html fallback → runtime [id] routes)
              build:desktop → Tauri frontendDist   build:web → static host/CDN
  desktop/    Tauri 2 Rust shell (window/tray/updater/keyring); consumes app's static build
  server/     SvelteKit adapter-node API — REST + SSE, better-auth, Drizzle+Postgres+pgvector
packages/
  ui/         Shared Svelte 5 components
  schemas/    Zod schemas — single source of truth for API + DB types
  api-client/ Typed fetch client used by every target
```

### Why this stack (researched 2026-07-04)

- **Tauri over Next.js-in-Tauri**: Next.js static export cannot represent runtime-created `/folders/<id>` routes; SvelteKit's SPA fallback solves this by design. Svelte 5 also has a smaller runtime and lower memory — meaningful for an all-day-open desktop app.
- **SvelteKit backend**: adapter-node is production-viable as a standalone API. Realtime is **SSE** (SvelteKit has no native WebSockets and doesn't need them here). Uploads go **direct-to-S3 via presigned URLs** (adapter-node's 512 KB body limit).
- **Data**: Postgres + pgvector (semantic) + FTS (lexical) → hybrid RRF search; Drizzle ORM; pg-boss jobs (no Redis); better-auth (multi-tenant orgs, RBAC, SSO).

## Quick start (zero external services)

```bash
pnpm install
pnpm dev            # UI on :5173  +  API on :5174 (in-memory seed data)
pnpm dev:desktop    # Tauri desktop app (spawns the UI dev server itself)
```

The app runs fully on **seeded in-memory data** — no database or keys required. Open http://localhost:5173.

## Production data path (optional)

```bash
docker compose up -d                                   # Postgres+pgvector, MinIO
cp apps/server/.env.example apps/server/.env           # set DATABASE_URL, S3_*, GEMINI_API_KEY
pnpm --filter @insightlibrary/server db:push           # create schema
pnpm --filter @insightlibrary/server db:seed           # load the demo dataset
pnpm --filter @insightlibrary/server worker            # ingestion worker (pg-boss)
```

When `DATABASE_URL` is set the server switches from the in-memory repository to Postgres, and `better-auth` sessions replace the dev auth bypass. When `GEMINI_API_KEY` is set the copilot streams live from Gemini (otherwise a local mock stream).

## Build

```bash
pnpm build              # all workspace packages
pnpm build:desktop      # desktop installers (per-OS via CI matrix in .github/workflows/ci.yml)
pnpm --filter @insightlibrary/app build:web   # static web bundle → any CDN
```

## Requirements

- Node ≥ 22, pnpm 10
- Rust stable + [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for the desktop/mobile shell

The original Next.js prototype (one directory up) is the visual/functional specification.
