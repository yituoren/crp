#!/usr/bin/env bash
# 在服务器上导入旧版单页系统的备份（写入正式数据库 /opt/crp/data）。
# 用法：bash /opt/crp/deploy/import-prototype.sh backup.json [YYYY-MM-DD] [--wipe]
set -euo pipefail
cd /opt/crp
DATA_DIR=${DATA_DIR:-/opt/crp/data} npm run --silent import-prototype --workspace=server -- "$@"
chown -R crp:crp /opt/crp/data
