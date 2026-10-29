#!/usr/bin/env bash
# Pull latest code, rebuild and restart (run as root on the server).
# GitHub can hang from mainland servers, so the Gitee mirror (kept in sync by .github/workflows/sync-gitee.yml) is tried first.
# Each pull attempt is capped at 60 s. An optional commit hash argument makes the script stop unless it ends up on that commit.
set -euo pipefail
cd /opt/crp
EXPECT="${1:-}"
GITEE_URL=https://gitee.com/yituoren/crp.git
SOURCES=(gitee origin)
echo "==> Pulling latest code"
git config --global --get-all safe.directory 2>/dev/null | grep -qx /opt/crp || git config --global --add safe.directory /opt/crp
# Pull through named remotes so their tracking refs stay current; main tracks Gitee, the source normally used
git remote get-url gitee >/dev/null 2>&1 || git remote add gitee "$GITEE_URL"
git config branch.main.remote gitee
# A source counts only if the pull succeeds and, when a hash was given, lands on it (the mirror can lag a minute behind GitHub)
on_expected() { [ -z "$EXPECT" ] || [ "$(git rev-parse HEAD)" = "$(git rev-parse --verify --quiet "$EXPECT^{commit}" || echo none)" ]; }
pulled=
for i in 1 2 3; do
  for src in "${SOURCES[@]}"; do
    if timeout 60 git pull --ff-only "$src" main && on_expected; then pulled=$src; break 2; fi
    echo "git pull from $src failed or is not at $EXPECT yet"
  done
  [ "$i" = 3 ] && { echo "could not get the code from any source; not rebuilding"; exit 1; }
  echo "retrying in 20s ($i/3)"; sleep 20
done
echo "Pulled from $pulled: $(git log --oneline -1)"
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
