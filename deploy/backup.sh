#!/usr/bin/env bash
# Back up the SQLite database (online backup, WAL-safe) and the uploads directory
set -euo pipefail
DATA_DIR=${DATA_DIR:-/opt/crp/data}
OUT=${BACKUP_DIR:-/opt/crp/backups}
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$OUT"
sqlite3 "$DATA_DIR/crp.db" ".backup '$OUT/crp-$STAMP.db'"
tar -czf "$OUT/uploads-$STAMP.tar.gz" -C "$DATA_DIR" uploads 2>/dev/null || true
find "$OUT" -type f -mtime +30 -delete
echo "[$(date)] backup ok: $OUT/crp-$STAMP.db"
