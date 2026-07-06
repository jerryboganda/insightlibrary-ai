#!/usr/bin/env bash
# VPS-side wrapper: always the same project name, env file, and compose file.
#   deploy/scripts/compose.sh up -d --build
#   deploy/scripts/compose.sh ps
#   deploy/scripts/compose.sh logs -f insight-api
set -euo pipefail
cd /opt/insight/app
exec docker compose --env-file .env -f deploy/docker-compose.yml -p insight "$@"
