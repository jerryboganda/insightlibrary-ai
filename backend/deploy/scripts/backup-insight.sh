#!/usr/bin/env bash
# Nightly backup of the `insight` production stack: Postgres logical dump +
# MinIO object store, written to /opt/insight/backups with 7-day rotation.
#
# Installed on the VPS via cron (see deploy note below). Self-contained: reads
# DB creds from /opt/insight/app/.env, dumps from the running postgres
# container, and tars the MinIO data volume via a throwaway alpine container.
#
#   Cron (root):  30 3 * * * /opt/insight/app/deploy/scripts/backup-insight.sh >> /var/log/insight-backup.log 2>&1
#
# NOTE: this is a LOCAL rotating backup (same box). For true DR, replicate
# /opt/insight/backups offsite (rclone to a user-owned bucket / second host) —
# that target is user-supplied, so it is intentionally left as a follow-up.
set -euo pipefail

APP_DIR=/opt/insight/app
BACKUP_DIR=/opt/insight/backups
KEEP_DAYS=7
STAMP=$(date +%Y%m%d-%H%M%S)
PROJECT=insight

mkdir -p "$BACKUP_DIR"

# Read PG_USER / PG_DB from the stack .env (fall back to defaults).
PG_USER=$(grep -E '^PG_USER=' "$APP_DIR/.env" | cut -d= -f2- || true); PG_USER=${PG_USER:-insight}
PG_DB=$(grep -E '^PG_DB=' "$APP_DIR/.env" | cut -d= -f2- || true); PG_DB=${PG_DB:-insight}

echo "[$(date -Is)] insight backup start (stamp=$STAMP)"

# 1. Postgres logical dump (gzip). --clean/--if-exists makes restore idempotent.
PG_CID=$(docker ps -qf "name=${PROJECT}-postgres-1")
if [ -z "$PG_CID" ]; then echo "ERROR: ${PROJECT}-postgres-1 not running"; exit 1; fi
docker exec "$PG_CID" pg_dump -U "$PG_USER" -d "$PG_DB" --clean --if-exists \
  | gzip > "$BACKUP_DIR/pg-${STAMP}.sql.gz"
echo "[$(date -Is)] pg dump: $(du -h "$BACKUP_DIR/pg-${STAMP}.sql.gz" | cut -f1)"

# 2. MinIO object store: tar the named volume through a scratch alpine.
docker run --rm \
  -v "${PROJECT}_miniodata:/data:ro" \
  -v "$BACKUP_DIR:/backup" \
  alpine:3 sh -c "tar czf /backup/minio-${STAMP}.tar.gz -C /data ."
echo "[$(date -Is)] minio tar: $(du -h "$BACKUP_DIR/minio-${STAMP}.tar.gz" | cut -f1)"

# 3. Rotate: delete dumps older than KEEP_DAYS.
find "$BACKUP_DIR" -name 'pg-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
find "$BACKUP_DIR" -name 'minio-*.tar.gz' -mtime +"$KEEP_DAYS" -delete

echo "[$(date -Is)] insight backup done; retained:"
ls -1t "$BACKUP_DIR"/pg-*.sql.gz | head -3
