# syntax=docker/dockerfile:1
# Static SPA build of apps/app (web target), served by Caddy on :80. Built from
# the monorepo ROOT (it needs the workspace packages), pushed to GHCR by GitHub
# Actions, and reverse-proxied by the stack's front-door caddy.
#
# VITE_API_URL is inlined at BUILD time by Vite, so it is a build-arg — NOT a
# runtime env. The deploy workflow passes the public API origin.

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
# Install only the web app + its workspace deps (skips tauri/desktop/server).
RUN pnpm install --frozen-lockfile --filter @insightlibrary/app...
ARG VITE_API_URL=https://insight-api.polytronx.com
ENV VITE_API_URL=$VITE_API_URL
RUN pnpm --filter @insightlibrary/app build:web

FROM caddy:2-alpine
COPY --from=build /repo/apps/app/build /srv
# SPA fallback: unknown paths serve index.html so client-side routes resolve.
RUN printf ':80 {\n\troot * /srv\n\ttry_files {path} /index.html\n\tfile_server\n\tencode gzip\n}\n' > /etc/caddy/Caddyfile
