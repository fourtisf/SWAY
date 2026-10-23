#!/usr/bin/env bash
# Turns on $SWAY staking with the live token (mainnet deploys without staking): deploys SwayStaking for the token,
# points it at SwayKeys and, when the operator key owns SwayKeys, points SwayKeys at it. Run as root after sway-update:
#   bash /srv/sway/deploy/setup-staking.sh [token address]
# The token defaults to NEXT_PUBLIC_SWAY_CA, else $SWAY on Pons. Levels 1..4 default to 0.01%, 0.1%, 0.5% and 1% of
# the token's supply; STAKING_THRESHOLDS="a,b,c,d" (whole tokens) overrides them. It asks before sending anything.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root: bash $0" >&2; exit 1; }
ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
ENV="$ROOT/.env"
APP_USER="$(stat -c %U "$ROOT")"
get() { sed -n "s/^$1=//p" "$ENV" | tail -1 | sed 's/^"\(.*\)"$/\1/'; }
set_env() { if grep -q "^$1=" "$ENV"; then sed -i "s#^$1=.*#$1=$2#" "$ENV"; else echo "$1=$2" >>"$ENV"; fi; }
as_app_env() { sudo -u "$APP_USER" -H "$@"; }
FPATH="/home/$APP_USER/.foundry/bin:/usr/bin:/bin"
CAST() { as_app_env env PATH="$FPATH" cast "$@"; }
lc() { tr 'A-F' 'a-f'; }

OFFICIAL=0x14bb48d197bf0c139580da26f456f9f7a8d13675
TOKEN="${1:-$(get NEXT_PUBLIC_SWAY_CA)}"
TOKEN="${TOKEN:-$OFFICIAL}"
CHAIN="$(get CHAIN_ID)"
RPC="$(get RPC_URL)"
KEYS="$(get SWAY_KEYS_ADDRESS)"
[ -n "$KEYS" ] || { echo "SwayKeys isn't deployed yet: run setup-chain.sh first" >&2; exit 1; }
[ -z "$(get SWAY_STAKING_ADDRESS)" ] || { echo "staking is already set up: $(get SWAY_STAKING_ADDRESS)"; exit 0; }
[[ "$TOKEN" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "not a token address: $TOKEN" >&2; exit 1; }
GOT="$(CAST chain-id --rpc-url "$RPC" || true)"
[ "$GOT" = "$CHAIN" ] || { echo "the RPC at $RPC answers chain '$GOT', expected $CHAIN" >&2; exit 1; }
MAINNET=0
[ "$CHAIN" = 4663 ] && MAINNET=1
PK="$(get OPERATOR_PRIVATE_KEY)"
ADDR="$(CAST wallet address --private-key "$PK")"
OWNER=""
[ "$(get SINGLE_KEY)" = 1 ] || OWNER="$(get ADMIN_ADDRESS)"

echo "1/5 The token"
[ "$(CAST code "$TOKEN" --rpc-url "$RPC")" != 0x ] || { echo "    no contract at $TOKEN on chain $CHAIN" >&2; exit 1; }
SYMBOL="$(CAST call "$TOKEN" 'symbol()(string)' --rpc-url "$RPC" | tr -d '"')"
DEC="$(CAST call "$TOKEN" 'decimals()(uint8)' --rpc-url "$RPC")"
SUPPLY="$(CAST call "$TOKEN" 'totalSupply()(uint256)' --rpc-url "$RPC" | awk '{print $1}')"
[ "$DEC" = 18 ] || { echo "    $SYMBOL has $DEC decimals; SwayStaking expects 18" >&2; exit 1; }
# Thresholds in token wei: STAKING_THRESHOLDS (whole tokens) or shares of the supply, rounded down to whole tokens.
read -r WEI SHOWN < <(node -e '
  const [supply, given] = [BigInt(process.argv[1]), process.argv[2]];
  const E = 10n ** 18n;
  const t = given ? given.split(",").map((x) => BigInt(x.trim()) * E) : [1n, 10n, 50n, 100n].map((bp) => ((supply * bp) / 10000n / E) * E);
  if (t.length !== 4 || t[0] === 0n || t.some((x, i) => i && x <= t[i - 1])) { console.error("thresholds must be 4 ascending non-zero amounts"); process.exit(1); }
  console.log(t.join(","), t.map((x) => (x / E).toLocaleString("en-US")).join(" / "));' "$SUPPLY" "${STAKING_THRESHOLDS:-}")
[ -n "${WEI:-}" ] || exit 1
echo "    $SYMBOL at $TOKEN, supply $(node -e 'console.log((BigInt(process.argv[1]) / 10n ** 18n).toLocaleString("en-US"))' "$SUPPLY")"
echo "    Levels 1..4 (Beat / Rhythm / Tempo / Crescendo): $SHOWN $SYMBOL"
echo "    Stakers get half of the 2% protocol fee in ETH; levels cut the protocol fee on their key trades by 10/25/50/75%."
read -r -p "    Deploy staking for $SYMBOL with these levels? Type yes: " OK
[ "$OK" = yes ] || { echo "    nothing sent"; exit 0; }

echo "2/5 Operator balance"
BAL="$(CAST balance "$ADDR" --rpc-url "$RPC")"
GP="$(CAST gas-price --rpc-url "$RPC")"
# The staking deploy is ~1.5M gas plus two small calls; ask for 3M worth.
read -r MIN NEED_ETH < <(node -e '
  const need = BigInt(process.argv[1]) * 3_000_000n;
  console.log(need.toString(), (Number(need) / 1e18).toFixed(6));' "$GP")
if [ "$(node -e 'console.log(BigInt(process.argv[1]) >= BigInt(process.argv[2]) ? 1 : 0)' "$BAL" "$MIN")" != 1 ]; then
  echo "    The operator wallet $ADDR needs at least $NEED_ETH ETH for this; send it, then run this again."
  exit 0
fi

echo "3/5 Deploying SwayStaking"
as_app_env env PATH="$FPATH" RPC="$RPC" PK="$PK" ALLOW_MAINNET="$MAINNET" SWAY_KEYS="$KEYS" SWAY_TOKEN="$TOKEN" \
  STAKING_THRESHOLDS="$WEI" OWNER="$OWNER" bash -lc \
  "cd '$ROOT/contracts' && if [ -n \"\$OWNER\" ]; then export ADMIN=\"\$OWNER\"; fi; ~/.foundry/bin/forge script script/DeployStaking.s.sol:DeployStaking --rpc-url \"\$RPC\" --private-key \"\$PK\" --broadcast --slow"
STAKING="$(node -e '
  const r = require(process.argv[1]);
  const t = r.transactions.find((x) => x.contractName === "SwayStaking" && x.transactionType === "CREATE");
  console.log(t ? t.contractAddress : "");' "$ROOT/contracts/broadcast/DeployStaking.s.sol/$CHAIN/run-latest.json")"
[ -n "$STAKING" ] || { echo "    couldn't find the new SwayStaking in the broadcast record" >&2; exit 1; }
set_env SWAY_STAKING_ADDRESS "$STAKING"
chown "$APP_USER:$APP_USER" "$ENV"
chmod 600 "$ENV"
echo "    SwayStaking $STAKING"

echo "4/5 Pointing SwayKeys at it"
KEYS_OWNER="$(CAST call "$KEYS" 'owner()(address)' --rpc-url "$RPC")"
TURNED_ON=0
if [ "$(echo "$KEYS_OWNER" | lc)" = "$(echo "$ADDR" | lc)" ]; then
  CAST send "$KEYS" 'setStaking(address)' "$STAKING" --private-key "$PK" --rpc-url "$RPC" >/dev/null
  TURNED_ON=1
  echo "    done: key trades now pay stakers and apply levels"
else
  echo "    SwayKeys belongs to $KEYS_OWNER: that wallet turns it on (see below)"
fi

echo "5/5 Build and restart"
bash "$ROOT/deploy/update.sh"

echo
echo "Staking is open at $(get WEB_URL)/staking for $SYMBOL."
if [ "$TURNED_ON" = 0 ]; then
  echo "Turn it on for key trades with the SwayKeys owner wallet ($KEYS_OWNER): $(get WEB_URL)/admin → Contracts → Turn on staking."
  echo "Until then members can stake, but levels don't cut fees yet and the stakers' share still goes to the treasury."
fi
if [ -n "$OWNER" ]; then
  echo "Accept SwayStaking's ownership with your owner wallet ($OWNER): $(get WEB_URL)/admin → Contracts → SwayStaking → Accept."
fi
