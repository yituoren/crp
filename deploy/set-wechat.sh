#!/usr/bin/env bash
# Configure WeChat mini program sign-in (run as root on the server):
#
#   bash deploy/set-wechat.sh <AppID>
#
# Prompts for the AppSecret without echoing it and stores both in a systemd drop-in readable by root only
# (update.sh replaces only the main unit, so the drop-in stays). Running it again replaces the values.
set -euo pipefail
APPID="${1:-}"
if [ -z "$APPID" ]; then echo "Usage: set-wechat.sh <AppID>"; exit 1; fi
read -r -s -p "AppSecret: " SECRET; echo
if [ -z "$SECRET" ]; then echo "No AppSecret entered, nothing changed"; exit 1; fi
DROPIN=/etc/systemd/system/crp.service.d/wechat.conf
mkdir -p "$(dirname "$DROPIN")"
umask 077
printf '[Service]\nEnvironment=WX_APPID=%s\nEnvironment=WX_SECRET=%s\n' "$APPID" "$SECRET" > "$DROPIN"
chmod 600 "$DROPIN"
systemctl daemon-reload
systemctl restart crp
echo "Mini program sign-in configured for $APPID; the service was restarted."
