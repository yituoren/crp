#!/usr/bin/env bash
# Configure WeChat message push for the content security verdicts on images (run as root on the server):
#
#   bash deploy/set-wechat-push.sh
#
# Generates a random Token, stores it in a systemd drop-in readable by root only, restarts the service and prints the
# Token once. Then, in the mini program admin console (开发管理 → 开发设置 → 消息推送), enter:
#   URL https://<domain>/api/wx/push, that Token, any EncodingAESKey (随机生成), 明文模式, data format JSON
# Running it again replaces the Token (enter the new one in the console too).
set -euo pipefail
TOKEN="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)"
DROPIN=/etc/systemd/system/crp.service.d/wechat-push.conf
mkdir -p "$(dirname "$DROPIN")"
umask 077
printf '[Service]\nEnvironment=WX_PUSH_TOKEN=%s\n' "$TOKEN" > "$DROPIN"
chmod 600 "$DROPIN"
systemctl daemon-reload
systemctl restart crp
echo "Message push Token (enter it in the mini program admin console): $TOKEN"
