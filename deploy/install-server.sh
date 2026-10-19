#!/usr/bin/env bash
# One-time setup of an Ubuntu 24.04 VPS for Sway. Run as root from the cloned repo (safe to re-run):
#   DOMAIN=swayfamily.com EMAIL=you@example.com bash /srv/sway/deploy/install-server.sh
# Installs Node 22 + pnpm + PM2, PostgreSQL, Redis, nginx + Let's Encrypt and a firewall; creates the database,
# writes a production .env (random secrets; you fill in X, chain and operator values) and starts nothing.
# The apps run as the `sway` user that owns /srv/sway. See deploy/DEPLOY.md for the whole sequence.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
DOMAIN="${DOMAIN:?set DOMAIN, e.g. DOMAIN=swayfamily.com}"
EMAIL="${EMAIL:?set EMAIL for certificate expiry notices}"
APP_USER=sway
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PNPM_VERSION="$(node -e "console.log(require('$ROOT/package.json').packageManager.split('@')[1])" 2>/dev/null || echo 10.28.0)"

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git build-essential openssl nginx postgresql redis-server certbot ufw
if ! node -v 2>/dev/null | grep -q '^v22\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
corepack enable
corepack prepare "pnpm@$PNPM_VERSION" --activate
command -v pm2 >/dev/null || npm install -g pm2
systemctl enable --now postgresql redis-server nginx

echo "== swap (next build needs ~2-3 GB of memory)"
if [ -z "$(swapon --show)" ] && [ "$(free -m | awk '/^Mem:/ {print $2}')" -lt 6000 ]; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

echo "== app user"
id -u "$APP_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos '' "$APP_USER"
chown -R "$APP_USER:$APP_USER" "$ROOT"
mkdir -p /var/backups/sway "$ROOT/uploads" && chown "$APP_USER:$APP_USER" /var/backups/sway "$ROOT/uploads"

echo "== database"
DB_PASS=""
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='sway'" | grep -q 1; then
  DB_PASS="$(openssl rand -hex 24)"
  sudo -u postgres psql -c "CREATE ROLE sway LOGIN PASSWORD '$DB_PASS'"
fi
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='sway'" | grep -q 1 || sudo -u postgres createdb -O sway sway

echo "== production .env"
ENV="$ROOT/.env"
if [ ! -f "$ENV" ]; then
  [ -n "$DB_PASS" ] || { echo "the sway database role already exists: write $ENV by hand (DATABASE_URL)" >&2; exit 1; }
  cp "$ROOT/.env.example" "$ENV"
  set_env() { if grep -q "^$1=" "$ENV"; then sed -i "s#^$1=.*#$1=$2#" "$ENV"; else echo "$1=$2" >>"$ENV"; fi; }
  set_env DATABASE_URL "postgresql://sway:$DB_PASS@localhost:5432/sway"
  set_env API_HOST 127.0.0.1
  set_env API_URL http://127.0.0.1:4000
  set_env WEB_URL "https://$DOMAIN"
  set_env NEXT_PUBLIC_WS_URL "wss://$DOMAIN/ws"
  set_env SESSION_SECRET "$(openssl rand -hex 32)"
  set_env X_CALLBACK_URL "https://$DOMAIN/api/auth/x/callback"
  set_env DEV_AUTH 0
  # FILL_ME stops deploy/update.sh until the value is set (blank would fall back to a local chain).
  for k in CHAIN_ID CHAIN_NAME RPC_URL OPERATOR_PRIVATE_KEY; do set_env "$k" FILL_ME; done
  set_env UPLOAD_DIR "$ROOT/uploads"
  set_env VAPID_SUBJECT "mailto:$EMAIL"
  node "$ROOT/scripts/vapid-keys.mjs" | while IFS='=' read -r k v; do set_env "$k" "$v"; done
  chown "$APP_USER:$APP_USER" "$ENV"
  chmod 600 "$ENV"
  echo "wrote $ENV: replace every FILL_ME, then set X_*, EXPLORER_URL, ISSUER_PRIVATE_KEY and ADMIN_HANDLES"
else
  echo "$ENV exists, left as is"
fi

echo "== firewall"
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo "== TLS certificate for $DOMAIN"
mkdir -p /var/www/certbot
if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  # Plain HTTP site first so certbot can answer the challenge.
  cat >/etc/nginx/sites-available/sway <<NGINX
server {
  listen 80;
  server_name $DOMAIN www.$DOMAIN;
  location /.well-known/acme-challenge/ { root /var/www/certbot; }
  location / { return 503; }
}
NGINX
  ln -sf /etc/nginx/sites-available/sway /etc/nginx/sites-enabled/sway
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx
  certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" -d "www.$DOMAIN" --email "$EMAIL" --agree-tos --non-interactive
fi
sed "s/swayfamily\.com/$DOMAIN/g" "$ROOT/deploy/nginx.conf" >/etc/nginx/sites-available/sway
ln -sf /etc/nginx/sites-available/sway /etc/nginx/sites-enabled/sway
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
# certbot's systemd timer renews; reload nginx after each renewal.
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nsystemctl reload nginx\n' >/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

echo "== PM2 on boot and nightly backups"
env PATH="$PATH" pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" >/dev/null
CRON="15 3 * * * $ROOT/deploy/backup.sh >> /var/backups/sway/backup.log 2>&1"
( crontab -u "$APP_USER" -l 2>/dev/null | grep -v 'deploy/backup.sh'; echo "$CRON" ) | crontab -u "$APP_USER" -

echo
echo "Server ready. Next: edit $ENV, then as $APP_USER run deploy/update.sh (see deploy/DEPLOY.md)."
