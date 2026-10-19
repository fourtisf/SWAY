#!/usr/bin/env bash
# Starts anvil (if it isn't running), deploys every contract with anvil account #0 as admin, operator,
# issuer and launch signer, and writes the addresses into the repo-root .env.
# Usage: bash scripts/deploy-local.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RPC="${RPC_URL:-http://127.0.0.1:8545}"
# anvil's well-known dev key #0. Never use it outside a local chain.
KEY0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

if ! cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "starting anvil on $RPC"
  (anvil --chain-id 31337 --block-time 1 --silent >"$ROOT/contracts/anvil.log" 2>&1 &)
  for _ in $(seq 1 50); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.2; done
fi
CHAIN_ID="$(cast chain-id --rpc-url "$RPC")"
if [ "$CHAIN_ID" != "31337" ]; then echo "refusing: $RPC is chain $CHAIN_ID, not a local anvil" >&2; exit 1; fi

cd "$ROOT/contracts"
mkdir -p deployments
forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --private-key "$KEY0" --broadcast --slow >/dev/null
DEP="deployments/31337.json"
cp "$DEP" deployments/local.json

ENV="$ROOT/.env"
[ -f "$ENV" ] || cp "$ROOT/.env.example" "$ENV"
set_env() { # key value
  if grep -q "^$1=" "$ENV"; then sed -i "s#^$1=.*#$1=$2#" "$ENV"; else echo "$1=$2" >>"$ENV"; fi
}
j() { node -e "console.log(require('./$DEP')['$1'])"; }
set_env CHAIN_ID 31337
set_env RPC_URL "$RPC"
set_env SWAY_KEYS_ADDRESS "$(j swayKeys)"
set_env FAN_ESCROW_ADDRESS "$(j fanEscrow)"
set_env SWAY_STAKING_ADDRESS "$(j swayStaking)"
set_env GENESIS_PASS_ADDRESS "$(j genesisPass)"
set_env LAUNCHPAD_ADDRESS "$(j launchpad)"
set_env DROPS_ADDRESS "$(j drops)"
set_env INDEXER_START_BLOCK "$(j startBlock)"
set_env OPERATOR_PRIVATE_KEY "$KEY0"
set_env ISSUER_PRIVATE_KEY "$KEY0"
echo "deployed to anvil; addresses written to .env:"
grep -E "^(SWAY_KEYS|FAN_ESCROW|SWAY_STAKING|GENESIS_PASS|LAUNCHPAD|DROPS)_ADDRESS=" "$ENV"
