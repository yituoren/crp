#!/usr/bin/env bash
# 备份 SQLite 数据库（WAL 模式下安全的在线备份）与附件目录
set -euo pipefail
DATA_DIR=${DATA_DIR:-/opt/crp/data}
OUT=${BACKUP_DIR:-/opt/crp/backups}
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$OUT"
sqlite3 "$DATA_DIR/crp.db" ".backup '$OUT/crp-$STAMP.db'"
tar -czf "$OUT/uploads-$STAMP.tar.gz" -C "$DATA_DIR" uploads 2>/dev/null || true
find "$OUT" -type f -mtime +30 -delete
echo "[$(date)] backup ok: $OUT/crp-$STAMP.db"
