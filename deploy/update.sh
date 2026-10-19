#!/usr/bin/env bash
# Builds and (re)starts Sway from the checked-out branch. Run as the app user after every change:
#   sudo -iu sway bash /srv/sway/deploy/update.sh
# pull → install → migrate → build → PM2 reload (zero-downtime for the API cluster).
# Everything runs inside main(): bash reads scripts as it goes, and `git pull` may rewrite this file.
set -euo pipefail

main() {
  local root
  root="$(cd "$(dirname "$0")/.." && pwd)"
  cd "$root"
  [ "$(id -u)" != 0 ] || { echo "run as the app user: sudo -iu sway bash $0" >&2; exit 1; }
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
