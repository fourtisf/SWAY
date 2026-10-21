#!/usr/bin/env bash
# Adds the token launchpad to a chain whose other contracts are already deployed (mainnet deploys without it).
# Graduated launches move into Uniswap V2 by themselves, so the launchpad's owner can't touch launch funds.
# Run as root, after `sway-update`:
#   bash /srv/sway/deploy/setup-launchpad.sh
# On mainnet it first replays a launch graduating into the real Uniswap pool on a fork (no transaction sent) and
# stops if that fails.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root: bash $0" >&2; exit 1; }
ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
ENV="$ROOT/.env"
APP_USER="$(stat -c %U "$ROOT")"
get() { sed -n "s/^$1=//p" "$ENV" | tail -1 | sed 's/^"\(.*\)"$/\1/'; }
as_app_env() { sudo -u "$APP_USER" -H "$@"; }
FPATH="/home/$APP_USER/.foundry/bin:/usr/bin:/bin"
CAST() { as_app_env env PATH="$FPATH" cast "$@"; }

CHAIN="$(get CHAIN_ID)"
RPC="$(get RPC_URL)"
KEYS="$(get SWAY_KEYS_ADDRESS)"
[ -n "$KEYS" ] || { echo "SwayKeys isn't deployed yet: run setup-chain.sh first" >&2; exit 1; }
[ -z "$(get LAUNCHPAD_ADDRESS)" ] || { echo "the launchpad is already deployed: $(get LAUNCHPAD_ADDRESS)"; exit 0; }
GOT="$(CAST chain-id --rpc-url "$RPC" || true)"
[ "$GOT" = "$CHAIN" ] || { echo "the RPC at $RPC answers chain '$GOT', expected $CHAIN" >&2; exit 1; }
MAINNET=0
[ "$CHAIN" = 4663 ] && MAINNET=1
ADDR="$(CAST wallet address --private-key "$(get OPERATOR_PRIVATE_KEY)")"
OWNER=""
[ "$(get SINGLE_KEY)" = 1 ] || OWNER="$(get ADMIN_ADDRESS)"

if [ "$MAINNET" = 1 ]; then
  echo "1/4 Rehearsal: a launch graduating into Robinhood Chain's Uniswap V2, on a fork (nothing is sent)"
  as_app_env env PATH="$FPATH" ROBINHOOD_RPC="$RPC" bash -lc \
    "cd '$ROOT/contracts' && ~/.foundry/bin/forge test --match-path test/fork/RobinhoodUniswap.t.sol -vv" \
    || { echo "the fork rehearsal failed: not deploying (send the output above)" >&2; exit 1; }
else
  echo "1/4 No Uniswap rehearsal off mainnet (a stand-in pool is deployed with the launchpad)"
fi

echo "2/4 Operator balance"
BAL="$(CAST balance "$ADDR" --rpc-url "$RPC")"
GP="$(CAST gas-price --rpc-url "$RPC")"
# The launchpad deploy is ~4M gas; ask for 6M worth so it can't run dry halfway.
read -r MIN NEED_ETH < <(node -e '
  const need = BigInt(process.argv[1]) * 6_000_000n;
  console.log(need.toString(), (Number(need) / 1e18).toFixed(6));' "$GP")
if [ "$(node -e 'console.log(BigInt(process.argv[1]) >= BigInt(process.argv[2]) ? 1 : 0)' "$BAL" "$MIN")" != 1 ]; then
  echo "    The operator wallet $ADDR needs at least $NEED_ETH ETH for this deploy; send it, then run this again."
  exit 0
fi

echo "3/4 Deploying SwayLaunchpad (a minute or two)"
as_app_env env PATH="$FPATH" RPC="$RPC" PK="$(get OPERATOR_PRIVATE_KEY)" ALLOW_MAINNET="$MAINNET" SWAY_KEYS="$KEYS" \
  LAUNCH_SIGNER="$ADDR" OWNER="$OWNER" bash -lc \
  "cd '$ROOT/contracts' && if [ -n \"\$OWNER\" ]; then export ADMIN=\"\$OWNER\"; fi; ~/.foundry/bin/forge script script/DeployLaunchpad.s.sol:DeployLaunchpad --rpc-url \"\$RPC\" --private-key \"\$PK\" --broadcast --slow"
bash "$ROOT/scripts/apply-deployment.sh" "$CHAIN"
chown "$APP_USER:$APP_USER" "$ENV"
chmod 600 "$ENV"

echo "4/4 Build and restart"
bash "$ROOT/deploy/update.sh"

echo
echo "Token launches are open: $(get LAUNCHPAD_ADDRESS)"
if [ -n "$OWNER" ]; then
  echo "Accept its ownership with your owner wallet ($OWNER): $(get WEB_URL)/admin → Contracts → SwayLaunchpad → Accept."
fi
