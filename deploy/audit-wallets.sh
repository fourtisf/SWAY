#!/usr/bin/env bash
# Read-only audit of members' wallets: ETH deposited from outside, what their key trades paid and got back, where
# every fee went, what is still waiting to be claimed, and which outside addresses ETH came from or went to.
# Sends nothing. Run as root or as the app user, after sway-update:
#   bash /srv/sway/deploy/audit-wallets.sh swaydotfamily _sonic_hub bittez [operator] [treasury] [0xOtherWallet …]
#   bash /srv/sway/deploy/audit-wallets.sh --all
#   bash /srv/sway/deploy/audit-wallets.sh --list swaydotfamily _sonic_hub bittez_   (just the addresses + explorer links)
# Handles take all of that member's wallets (Sway wallet + linked); `operator` and `treasury` add Sway's own wallets;
# moves between the audited wallets cancel out. It also lists who traded the audited members' keys.
set -euo pipefail
ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
OWNER="$(stat -c %U "$ROOT")"
if [ "$(id -u)" = 0 ] && [ "$OWNER" != root ]; then
  exec sudo -iu "$OWNER" bash "$ROOT/deploy/audit-wallets.sh" "$@"
fi
cd "$ROOT"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
exec pnpm --silent --filter @sway/workers audit:wallets "$@"
