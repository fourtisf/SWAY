#!/usr/bin/env bash
# Turns what the operator wallet still holds on Sway into ETH in that wallet: keys beyond the locked first one,
# SwayKeys earnings, launchpad creator fees, unclaimed airdrops and launchpad tokens. Asks before each transaction.
# Handles or addresses after it get a little gas and a list of what they still have to collect in the app (their
# keys live in the browser). Run as root or as the app user, after sway-update:
#   bash /srv/sway/deploy/sweep.sh _sonic_hub bittez_
# With --key it instead empties a wallet whose private key you paste (hidden, never saved), like a member's Sway
# wallet (Wallet → ⋯ → Back up key), into the operator wallet:
#   bash /srv/sway/deploy/sweep.sh --key
set -euo pipefail
ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
OWNER="$(stat -c %U "$ROOT")"
if [ "$(id -u)" = 0 ] && [ "$OWNER" != root ]; then
  exec sudo -iu "$OWNER" bash "$ROOT/deploy/sweep.sh" "$@"
fi
cd "$ROOT"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
exec pnpm --silent --filter @sway/workers sweep "$@"
