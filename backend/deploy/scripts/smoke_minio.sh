#!/usr/bin/env bash
# MinIO smoke test: authenticated PUT + presigned GET through the PUBLIC
# endpoint (Cloudflare edge -> tunnel -> caddy -> minio). Run on the VPS:
#   bash /opt/insight/app/deploy/scripts/smoke_minio.sh
set -euo pipefail
cd /opt/insight/app

URL=$(docker compose --env-file .env -f deploy/docker-compose.yml -p insight \
  run --rm --entrypoint /bin/sh minio-init -c '
    set -e
    mc alias set pub "'"${S3_PUBLIC:-https://insight-s3.polytronx.com}"'" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
    echo "smoke-$(date +%s)" > /tmp/smoke.txt
    mc cp /tmp/smoke.txt pub/documents/smoke-test/smoke.txt >/dev/null
    mc share download --expire 5m pub/documents/smoke-test/smoke.txt
  ' | grep -oE "https://[^ ]+smoke\.txt[^ ]*" | tail -1)

echo "presigned GET url obtained"
BODY=$(curl -sf --max-time 20 "$URL")
echo "presigned GET body: $BODY"
case "$BODY" in
  smoke-*) echo "SMOKE-OK: presigned round-trip via public endpoint works" ;;
  *) echo "SMOKE-FAIL"; exit 1 ;;
esac
