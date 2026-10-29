#!/usr/bin/env bash
# Put Nginx in front of the app (run as root on the server, after install.sh).
#
#   bash deploy/setup-nginx.sh <domain>                  HTTP only: Nginx on port 80, app moved to 127.0.0.1:3000
#   bash deploy/setup-nginx.sh <domain> --https [email]  also get a Let's Encrypt certificate and serve HTTPS
#
# <domain> is the primary address (e.g. cityrunproject.cn); www.<domain> redirects to it.
# The HTTPS step needs the domain to resolve to this server, port 80 reachable from the internet
# (for mainland servers: the ICP filing must be approved first) and port 443 open in the cloud firewall.
# Plain http://<server IP> keeps working in both modes. Running the script again is safe.
set -euo pipefail

DOMAIN="${1:-}"
MODE="${2:-}"
EMAIL="${3:-}"
if [ -z "$DOMAIN" ] || { [ -n "$MODE" ] && [ "$MODE" != "--https" ]; }; then
  echo "Usage: setup-nginx.sh <domain> [--https [email]]"; exit 1
fi
APP_PORT=3000
WEBROOT=/var/www/certbot
SITE=/etc/nginx/sites-available/crp
CERT_DIR=/etc/letsencrypt/live/$DOMAIN

# 1. Move the app off port 80 to localhost. A drop-in survives update.sh, which only replaces the main unit file.
DROPIN=/etc/systemd/system/crp.service.d/proxy.conf
if [ ! -f "$DROPIN" ]; then
  echo "==> Moving the app to 127.0.0.1:$APP_PORT"
  mkdir -p "$(dirname "$DROPIN")"
  printf '[Service]\nEnvironment=PORT=%s\nEnvironment=HOST=127.0.0.1\n' "$APP_PORT" > "$DROPIN"
  systemctl daemon-reload
  systemctl restart crp
  sleep 2
fi

# 2. Install Nginx (and certbot); the app no longer holds port 80, so Nginx can start
if ! command -v nginx >/dev/null 2>&1 || ! command -v certbot >/dev/null 2>&1; then
  echo "==> Installing nginx and certbot"
  apt-get update -y
  apt-get install -y nginx certbot
fi
mkdir -p "$WEBROOT"
rm -f /etc/nginx/sites-enabled/default

# Shared proxy settings: WebSocket upgrade for Socket.IO, long timeouts; bodies up to 200 MB for event-file imports (the app limits attachments to 10 MB itself)
cat > /etc/nginx/snippets/crp-proxy.conf <<EOF
client_max_body_size 200m;
location /.well-known/acme-challenge/ { root $WEBROOT; }
location / {
  proxy_pass http://127.0.0.1:$APP_PORT;
  proxy_http_version 1.1;
  proxy_set_header Host \$host;
  proxy_set_header X-Real-IP \$remote_addr;
  proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto \$scheme;
  proxy_set_header Upgrade \$http_upgrade;
  proxy_set_header Connection \$connection_upgrade;
  proxy_read_timeout 3600s;
  proxy_send_timeout 3600s;
}
EOF

write_http_site() {
  cat > "$SITE" <<EOF
map \$http_upgrade \$connection_upgrade { default upgrade; '' close; }

# Any host name or bare IP over HTTP: serve the app directly
server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name _;
  include snippets/crp-proxy.conf;
}
EOF
}

write_https_site() {
  cat > "$SITE" <<EOF
map \$http_upgrade \$connection_upgrade { default upgrade; '' close; }

# Bare IP (and unknown names) over HTTP: keep serving the app as before
server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name _;
  include snippets/crp-proxy.conf;
}

# The domain over HTTP: certificate challenges, everything else goes to https://$DOMAIN
server {
  listen 80;
  listen [::]:80;
  server_name $DOMAIN www.$DOMAIN;
  location /.well-known/acme-challenge/ { root $WEBROOT; }
  location / { return 301 https://$DOMAIN\$request_uri; }
}

# www over HTTPS: redirect to the primary address
server {
  listen 443 ssl;
  listen [::]:443 ssl;
  http2 on;
  server_name www.$DOMAIN;
  ssl_certificate $CERT_DIR/fullchain.pem;
  ssl_certificate_key $CERT_DIR/privkey.pem;
  return 301 https://$DOMAIN\$request_uri;
}

# Primary address over HTTPS
server {
  listen 443 ssl default_server;
  listen [::]:443 ssl default_server;
  http2 on;
  server_name $DOMAIN;
  ssl_certificate $CERT_DIR/fullchain.pem;
  ssl_certificate_key $CERT_DIR/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_session_cache shared:SSL:10m;
  include snippets/crp-proxy.conf;
}
EOF
}

reload_nginx() { nginx -t && systemctl enable nginx >/dev/null 2>&1 && systemctl reload-or-restart nginx; }

if [ "$MODE" != "--https" ]; then
  echo "==> Writing HTTP-only site"
  write_http_site
  ln -sf "$SITE" /etc/nginx/sites-enabled/crp
  reload_nginx
  echo
  echo "Nginx is serving the app on port 80. After the ICP filing is approved and port 443 is open, run:"
  echo "  bash $0 $DOMAIN --https [email]"
  exit 0
fi

# 3. Certificate via the webroot challenge (the HTTP site above already serves $WEBROOT)
if [ ! -f "$CERT_DIR/fullchain.pem" ]; then
  write_http_site
  ln -sf "$SITE" /etc/nginx/sites-enabled/crp
  reload_nginx
  echo "==> Requesting a Let's Encrypt certificate for $DOMAIN and www.$DOMAIN"
  if [ -n "$EMAIL" ]; then ACCOUNT=(-m "$EMAIL"); else ACCOUNT=(--register-unsafely-without-email); fi
  certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" -d "www.$DOMAIN" \
    --agree-tos --non-interactive "${ACCOUNT[@]}" --cert-name "$DOMAIN"
fi
# certbot's systemd timer renews automatically; reload Nginx whenever a renewed certificate is installed
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nsystemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

echo "==> Writing HTTPS site"
write_https_site
reload_nginx
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then ufw allow 443/tcp; fi
echo
echo "HTTPS is live: https://$DOMAIN (www.$DOMAIN and http:// redirect there; http://<server IP> still works)."
echo "Renewal is automatic; test it with: certbot renew --dry-run"
