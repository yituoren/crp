#!/usr/bin/env bash
# 首次部署脚本（在服务器上以 root 运行）。适用于 Ubuntu 22.04 / 24.04 / Debian 12。
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/<你的GitHub>/crp/main/deploy/install.sh | bash -s -- https://github.com/<你的GitHub>/crp.git
# 或先 git clone 到 /opt/crp 再执行：bash /opt/crp/deploy/install.sh
set -euo pipefail

REPO_URL="${1:-}"
APP_DIR=/opt/crp
DATA_DIR=/opt/crp/data

echo "==> 安装系统依赖"
apt-get update -y
apt-get install -y curl git sqlite3 ca-certificates

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "==> 安装 Node.js 22（node:sqlite 需要 >= 22.13）"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v && npm -v

if ! id crp >/dev/null 2>&1; then
  echo "==> 创建运行用户 crp"
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin crp
fi

if [ ! -d "$APP_DIR/.git" ]; then
  if [ -z "$REPO_URL" ]; then echo "请提供仓库地址：install.sh <git url>"; exit 1; fi
  echo "==> 克隆代码到 $APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"
echo "==> 安装依赖并构建"
npm ci
npm run build

mkdir -p "$DATA_DIR" "$APP_DIR/backups"
chown -R crp:crp "$APP_DIR"

echo "==> 允许 node 监听 80 端口"
setcap 'cap_net_bind_service=+ep' "$(readlink -f "$(command -v node)")"

echo "==> 安装 systemd 服务"
cp deploy/crp.service /etc/systemd/system/crp.service
systemctl daemon-reload
systemctl enable --now crp
sleep 2
systemctl --no-pager status crp | head -5

echo "==> 安装每日备份任务（每天 04:00，保留 30 天）"
chmod +x deploy/backup.sh deploy/update.sh
( crontab -u root -l 2>/dev/null | grep -v crp/deploy/backup.sh; echo "0 4 * * * $APP_DIR/deploy/backup.sh >> /var/log/crp-backup.log 2>&1" ) | crontab -u root -

if command -v ufw >/dev/null 2>&1; then ufw allow 80/tcp >/dev/null 2>&1 || true; fi

IP=$(curl -fsS -4 https://api.ipify.org || hostname -I | awk '{print $1}')
echo
echo "部署完成。用手机流量打开 http://$IP 检查是否可访问。"
echo "首个主办账号：用主办名单里的ID（默认 阳秋 / 云缨 / 云影）直接注册即可。"
