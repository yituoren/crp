#!/usr/bin/env bash
# First-time deploy script (run as root on the server). Ubuntu 22.04 / 24.04 / Debian 12 / 13.
# Usage:
#   git clone https://github.com/yituoren/crp.git /opt/crp && bash /opt/crp/deploy/install.sh [--cn]
# --cn: server in mainland China. apt (Debian) and Node.js come from the TUNA mirror (mirrors.tuna.tsinghua.edu.cn);
#       npm packages come from npmmirror because TUNA has no npm registry (package-lock.json keeps the official
#       URLs; npm rewrites the host).
set -euo pipefail

CN=0
REPO_URL=""
for a in "$@"; do
  case "$a" in
    --cn) CN=1 ;;
    *) REPO_URL="$a" ;;
  esac
done
APP_DIR=/opt/crp
DATA_DIR=/opt/crp/data
NODE_MAJOR=22

TUNA=https://mirrors.tuna.tsinghua.edu.cn
if [ "$CN" = 1 ] && [ -f /etc/debian_version ] && grep -q '^ID=debian' /etc/os-release; then
  CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
  echo "==> Switching apt to the TUNA mirror ($CODENAME)"
  for f in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do [ -f "$f" ] && mv "$f" "$f.bak-crp"; done
  cat > /etc/apt/sources.list.d/debian.sources <<SRC
Types: deb
URIs: $TUNA/debian
Suites: $CODENAME $CODENAME-updates
Components: main contrib non-free non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

Types: deb
URIs: $TUNA/debian-security
Suites: $CODENAME-security
Components: main contrib non-free non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
SRC
fi

echo "==> Installing system packages"
apt-get update -y
apt-get install -y curl git sqlite3 ca-certificates xz-utils libcap2-bin

# Small instances (2 GB RAM) can run out of memory while building the web bundle: add 2 GB of swap once
if ! swapon --show | grep -q . && [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 3500000 ]; then
  echo "==> Adding 2G swap file"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ]; then
  echo "==> Installing Node.js $NODE_MAJOR (node:sqlite requires >= 22.13)"
  if [ "$CN" = 1 ]; then
    BASE="$TUNA/nodejs-release/latest-v${NODE_MAJOR}.x"
    ARCH=$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')
    FILE=$(curl -fsSL "$BASE/SHASUMS256.txt" | awk '{print $2}' | grep "linux-${ARCH}.tar.xz$")
    curl -fsSL "$BASE/$FILE" -o /tmp/node.tar.xz
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 && rm -f /tmp/node.tar.xz
    ln -sf /usr/local/bin/node /usr/bin/node
    ln -sf /usr/local/bin/npm /usr/bin/npm
    ln -sf /usr/local/bin/npx /usr/bin/npx
  else
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    apt-get install -y nodejs
  fi
fi
node -v && npm -v
if [ "$CN" = 1 ]; then
  echo "==> Using npmmirror for npm packages"
  npm config set registry https://registry.npmmirror.com --location=global
fi

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

# Code owned by root (read-only for others); only data/backups owned by the service user crp
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
echo "Create the admin account: bash $APP_DIR/deploy/create-admin.sh <username> <password>"
