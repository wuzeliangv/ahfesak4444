#!/usr/bin/env bash
# Build the React frontend and publish it to /var/www/aws-panel where Caddy
# serves it. Run after editing anything under frontend/src.
#
# Usage:  bash scripts/deploy-frontend.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${REPO_ROOT}/frontend/dist"
DST="/var/www/aws-panel"

echo ">>> Building frontend bundle"
cd "${REPO_ROOT}/frontend"
npm run build

echo ">>> Syncing ${SRC}/  ->  ${DST}/"
rsync -a --delete "${SRC}/" "${DST}/"
chown -R caddy:caddy "${DST}"
chmod -R o-rwx "${DST}"

echo ">>> Verifying Caddy is healthy"
systemctl is-active caddy

echo ">>> Done. https://aws.se.sd/"
