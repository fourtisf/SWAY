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
# Contracts a deployment skipped (mainnet staking/launchpad) are written as the zero address: leave them empty.
j() { node -e "const v = require('$DEP')['$1']; console.log(!v || /^0x0{40}$/i.test(v) ? '' : v)"; }
set_env SWAY_KEYS_ADDRESS "$(j swayKeys)"
set_env FAN_ESCROW_ADDRESS "$(j fanEscrow)"
set_env SWAY_STAKING_ADDRESS "$(j swayStaking)"
set_env GENESIS_PASS_ADDRESS "$(j genesisPass)"
set_env LAUNCHPAD_ADDRESS "$(j launchpad)"
set_env DROPS_ADDRESS "$(j drops)"
set_env INDEXER_START_BLOCK "$(j startBlock)"
grep -E "^(SWAY_KEYS|FAN_ESCROW|SWAY_STAKING|GENESIS_PASS|LAUNCHPAD|DROPS)_ADDRESS=|^INDEXER_START_BLOCK=" "$ENV"
