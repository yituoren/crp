#!/usr/bin/env bash
# Create or reset an admin account on the server (writes to the production DB in /opt/crp/data).
# Usage: bash /opt/crp/deploy/create-admin.sh <username> <password>
set -euo pipefail
cd /opt/crp
DATA_DIR=${DATA_DIR:-/opt/crp/data} npm run --silent create-admin --workspace=server -- "$@"
chown -R crp:crp /opt/crp/data
