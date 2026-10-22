#!/usr/bin/env bash
# Writes the addresses from contracts/deployments/<chainId>.json (written by Deploy.s.sol) into the root .env.
# Usage: bash scripts/apply-deployment.sh [chainId]   (default: CHAIN_ID from .env)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV="$ROOT/.env"
CHAIN="${1:-$(grep -E '^CHAIN_ID=' "$ENV" | cut -d= -f2)}"
DEP="$ROOT/contracts/deployments/$CHAIN.json"
[ -f "$DEP" ] || { echo "no $DEP: deploy the contracts first" >&2; exit 1; }
set_env() { if grep -q "^$1=" "$ENV"; then sed -i "s#^$1=.*#$1=$2#" "$ENV"; else echo "$1=$2" >>"$ENV"; fi; }
cur() { sed -n "s/^$1=//p" "$ENV" | tail -1; }
# An address the record doesn't have (zero) keeps what .env has. A launchpad with live tokens never changes here:
# its tokens are only found through it (deploy/setup-launchpad.sh blanks it on purpose before a new one).
# Contracts a deployment skipped (mainnet staking/launchpad) are written as the zero address: leave them empty.
j() { node -e "const v = require('$DEP')['$1']; console.log(!v || /^0x0{40}$/i.test(v) ? '' : v)"; }
addr_env() { local v; v="$(j "$2")"; [ -n "$v" ] && set_env "$1" "$v"; return 0; }
addr_env SWAY_KEYS_ADDRESS swayKeys
addr_env FAN_ESCROW_ADDRESS fanEscrow
addr_env SWAY_STAKING_ADDRESS swayStaking
addr_env GENESIS_PASS_ADDRESS genesisPass
addr_env DROPS_ADDRESS drops
PAD="$(j launchpad)"
if [ -n "$PAD" ]; then
  if [ -n "$(cur LAUNCHPAD_ADDRESS)" ] && [ "$(cur LAUNCHPAD_ADDRESS | tr A-F a-f)" != "$(echo "$PAD" | tr A-F a-f)" ]; then
    echo "keeping LAUNCHPAD_ADDRESS=$(cur LAUNCHPAD_ADDRESS) (the record says $PAD); blank it first to switch launchpads" >&2
  else
    set_env LAUNCHPAD_ADDRESS "$PAD"
  fi
fi
# On Arbitrum-based chains (Robinhood Chain) block.number inside the deploy script is the parent chain's, far
# below the chain's own: start from the deploy transactions' blocks in the broadcast record when there is one.
start_block() {
  node -e '
    const fs = require("fs");
    const f = process.argv[1];
    let b = null;
    if (fs.existsSync(f)) for (const r of JSON.parse(fs.readFileSync(f, "utf8")).receipts ?? []) {
      const n = BigInt(r.blockNumber);
      if (b === null || n < b) b = n;
    }
    console.log(String(b ?? process.argv[2]));' "$ROOT/contracts/broadcast/Deploy.s.sol/$CHAIN/run-latest.json" "$(j startBlock)"
}
set_env INDEXER_START_BLOCK "$(start_block)"
grep -E "^(SWAY_KEYS|FAN_ESCROW|SWAY_STAKING|GENESIS_PASS|LAUNCHPAD|DROPS)_ADDRESS=|^INDEXER_START_BLOCK=" "$ENV"
