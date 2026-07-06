#!/usr/bin/env bash
# VPS-side deploy step: pull the prebuilt GHCR images and recreate the insight
# stack from those images only — never builds on the box (that's GitHub Actions'
# job). IMAGE_TAG must be exported by the caller (the deploy workflow sets it to
# the commit SHA); compose resolves image: ...:${IMAGE_TAG:-latest}.
set -euo pipefail
cd /opt/insight/app

SERVICES="insight-api insight-worker parser-svc inference-svc"

# ghcr.io over the VPS's IPv6 path occasionally resets mid-layer; retry the pull.
for i in 1 2 3 4 5; do
  if bash deploy/scripts/compose.sh pull $SERVICES; then
    echo "pull ok (attempt $i)"
    break
  fi
  if [ "$i" = 5 ]; then
    echo "pull failed after 5 attempts" >&2
    exit 1
  fi
  echo "pull attempt $i failed; retrying in 6s" >&2
  sleep 6
done

# --no-build guarantees no compilation on the VPS; errors if an image is absent.
bash deploy/scripts/compose.sh up -d --no-build --remove-orphans
