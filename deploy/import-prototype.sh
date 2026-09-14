#!/usr/bin/env bash
# Import a backup from the legacy single-page system (writes to the production DB in /opt/crp/data).
# Usage: bash /opt/crp/deploy/import-prototype.sh backup.json [YYYY-MM-DD] [--wipe]
set -euo pipefail
cd /opt/crp
DATA_DIR=${DATA_DIR:-/opt/crp/data} npm run --silent import-prototype --workspace=server -- "$@"
chown -R crp:crp /opt/crp/data
