#!/usr/bin/env bash
# Builds and (re)starts Sway from the checked-out branch. Run after every change, as root or as the app user:
#   sway-update        (shortcut, installed the first time this runs as root)
#   bash /srv/sway/deploy/update.sh
# It never asks for keys: they stay in .env (deploy/set-x-keys.sh changes the X ones).
# pull → install → migrate → build → PM2 reload (zero-downtime for the API cluster).
# Everything runs inside main(): bash reads scripts as it goes, and `git pull` may rewrite this file.
set -euo pipefail

main() {
  local root
  root="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
  cd "$root"
  if [ "$(id -u)" = 0 ]; then
    # root: install the shortcut, then build as the app user that owns the checkout.
    local self owner
    self="$root/deploy/update.sh"
    owner="$(stat -c %U "$root")"
    [ "$owner" != root ] || { echo "$root is owned by root; expected the app user" >&2; exit 1; }
    ln -sf "$self" /usr/local/bin/sway-update 2>/dev/null || true
    exec sudo -iu "$owner" bash "$self" "$@"
  fi
  [ -f .env ] || { echo "no .env: run deploy/install-server.sh first" >&2; exit 1; }
  if grep -n '=FILL_ME' .env; then echo "replace the FILL_ME values in .env first (or leave them empty)" >&2; exit 1; fi
  grep -q '^SWAY_KEYS_ADDRESS=0x' .env || echo "note: no contracts yet, so trading is off (deploy/DEPLOY.md step 4)"
  grep -q '^X_CLIENT_ID=.' .env || echo "note: X_CLIENT_ID is empty, so nobody can sign in yet (dev sign-in is off in production)"

  # corepack would otherwise stop and ask before downloading pnpm.
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  git pull --ff-only
  git submodule update --init --recursive
  pnpm install --frozen-lockfile
  pnpm db:deploy
  pnpm build
  pm2 startOrReload deploy/ecosystem.config.cjs --update-env
  pm2 save
  echo "deployed $(git rev-parse --short HEAD); check: pm2 status, curl -s localhost:4100/healthz"
}

main "$@"
