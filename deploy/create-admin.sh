#!/usr/bin/env bash
# 在服务器上创建/重置管理员账号（写入正式数据库 /opt/crp/data）。
# 用法：bash /opt/crp/deploy/create-admin.sh <用户名> <密码>
set -euo pipefail
cd /opt/crp
DATA_DIR=${DATA_DIR:-/opt/crp/data} npm run --silent create-admin --workspace=server -- "$@"
chown -R crp:crp /opt/crp/data
