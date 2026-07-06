#!/bin/sh
# Runs once at first cluster init (docker-entrypoint-initdb.d). Creates the
# NON-superuser login role the application connects as.
#
# WHY: the bootstrap POSTGRES_USER of the official postgres/pgvector image is
# a SUPERUSER, and superusers bypass row-level security entirely (FORCE ROW
# LEVEL SECURITY only binds non-superuser table owners). Connecting the app
# as the bootstrap user would silently disable tenant isolation. The app role
# instead OWNS the database so migrations work (CREATE TABLE etc.).
#
# Extensions are pre-created HERE as the superuser: `vector` is NOT marked
# trusted in this image, so the non-superuser app role cannot install it.
# The migrations' CREATE EXTENSION IF NOT EXISTS then no-op harmlessly.
#
# NOTE: like all initdb.d scripts this only runs on an EMPTY data volume. For
# an existing volume, create the role manually with the same statements.
set -eu

APP_DB_USER="${APP_DB_USER:-insight_app}"
APP_DB_PASSWORD="${APP_DB_PASSWORD:-insight_app}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE ROLE "${APP_DB_USER}"
    LOGIN PASSWORD '${APP_DB_PASSWORD}'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
ALTER DATABASE "${POSTGRES_DB}" OWNER TO "${APP_DB_USER}";
EOSQL

echo "postgres-init: created non-superuser app role ${APP_DB_USER} (owner of ${POSTGRES_DB})"
