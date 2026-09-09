#!/usr/bin/env bash
# 更新到最新代码并重启（在服务器上以 root 运行）
set -euo pipefail
cd /opt/crp
git pull --ff-only
npm ci
npm run build
chown -R crp:crp /opt/crp
systemctl restart crp
sleep 2
systemctl --no-pager status crp | head -5
