#!/usr/bin/env bash
# 首次部署脚本（在服务器上以 root 运行）。适用于 Ubuntu 22.04 / 24.04 / Debian 12。
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/yituoren/crp/main/deploy/install.sh | bash -s -- https://github.com/yituoren/crp.git
# 或先 git clone 到 /opt/crp 再执行：bash /opt/crp/deploy/install.sh
set -euo pipefail

REPO_URL="${1:-}"
APP_DIR=/opt/crp
DATA_DIR=/opt/crp/data

echo "==> Installing system packages"
apt-get update -y
apt-get install -y curl git sqlite3 ca-certificates

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "==> Installing Node.js 22 (node:sqlite requires >= 22.13)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v && npm -v

if ! id crp >/dev/null 2>&1; then
  echo "==> Creating service user crp"
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin crp
fi

if [ ! -d "$APP_DIR/.git" ]; then
  if [ -z "$REPO_URL" ]; then echo "Usage: install.sh <git url>"; exit 1; fi
  echo "==> Cloning repository into $APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"
git config --global --add safe.directory "$APP_DIR" >/dev/null 2>&1 || true
echo "==> Installing dependencies and building"
npm ci
npm run build

# 代码归 root、对所有人只读；只有数据和备份目录归运行用户 crp（最小权限）
mkdir -p "$DATA_DIR" "$APP_DIR/backups"
chown -R root:root "$APP_DIR"
chown -R crp:crp "$DATA_DIR" "$APP_DIR/backups"

echo "==> Allowing node to bind port 80"
setcap 'cap_net_bind_service=+ep' "$(readlink -f "$(command -v node)")"

echo "==> Installing systemd service"
cp deploy/crp.service /etc/systemd/system/crp.service
systemctl daemon-reload
systemctl enable --now crp
sleep 2
systemctl --no-pager status crp | head -5

echo "==> Installing daily backup cron job (04:00, keep 30 days)"
chmod +x deploy/backup.sh deploy/update.sh
( crontab -u root -l 2>/dev/null | grep -v crp/deploy/backup.sh; echo "0 4 * * * $APP_DIR/deploy/backup.sh >> /var/log/crp-backup.log 2>&1" ) | crontab -u root -

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  echo "==> ufw is active, allowing port 80"
  ufw allow 80/tcp
fi

IP=$(curl -fsS -4 https://api.ipify.org || hostname -I | awk '{print $1}')
echo
echo "Deploy complete. Open http://$IP from a phone on mobile data to verify access."
echo "First host account: register with a username from the host list (default: 阳秋 / 云缨 / 云影)."
