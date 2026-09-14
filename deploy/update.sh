#!/usr/bin/env bash
# Pull latest code, rebuild and restart (run as root on the server)
set -euo pipefail
cd /opt/crp
echo "==> Pulling latest code"
git config --global --add safe.directory /opt/crp >/dev/null 2>&1 || true
git pull --ff-only
echo "==> Installing dependencies and building"
npm ci
npm run build
chown -R root:root /opt/crp
chown -R crp:crp /opt/crp/data /opt/crp/backups
# Reinstall the unit file if it changed in the repo
if ! cmp -s deploy/crp.service /etc/systemd/system/crp.service; then
  echo "==> Updating systemd unit"
  cp deploy/crp.service /etc/systemd/system/crp.service
  systemctl daemon-reload
fi
echo "==> Restarting service"
systemctl restart crp
sleep 2
systemctl --no-pager status crp | head -5
