#!/usr/bin/env bash
# Read-only: what is waiting to be claimed in SwayKeys, and how some wallets' key trades add up. Sends nothing.
#   bash /srv/sway/deploy/check-earnings.sh 0xWallet1 0xWallet2 ...
# Every trade pays 10% in fees (creator 6%, protocol 2%, holders 1%, referral 1%; +5% to holders when selling within
# 24h of buying). They are credited inside the contract, not sent: each wallet claims its share (Wallet → Claim), and
# the treasury claims the protocol share. With no address it shows the treasury and the contract only.
set -euo pipefail
ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
ENV="${SWAY_ENV:-$ROOT/.env}"
get() { sed -n "s/^$1=//p" "$ENV" | tail -1 | sed 's/^"\(.*\)"$/\1/'; }
if [ "$(id -u)" = 0 ]; then
  APP_USER="$(stat -c %U "$ROOT")"
  CAST() { sudo -u "$APP_USER" -H env PATH="/home/$APP_USER/.foundry/bin:/usr/local/bin:/usr/bin:/bin" cast "$@"; }
else
  CAST() { env PATH="$HOME/.foundry/bin:$PATH" cast "$@"; }
fi
RPC="$(get RPC_URL)"
KEYS="$(get SWAY_KEYS_ADDRESS)"
DB="$(get DATABASE_URL | sed 's/?.*//')"
[ -n "$KEYS" ] || { echo "SWAY_KEYS_ADDRESS isn't set in $ENV" >&2; exit 1; }
PORT="$(get API_PORT)"
USD="$(curl -fsS -m 5 "http://127.0.0.1:${PORT:-4000}/api/price" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).ethUsd)}catch{console.log(0)}})' || echo 0)"
# wei → "0.012345 ETH ($41.20)"
fmt() { node -e 'const w=BigInt(process.argv[1]),u=Number(process.argv[2]);const e=Number(w)/1e18;console.log(`${e.toFixed(6)} ETH`+(u>0?` ($${(e*u).toFixed(2)})`:""));' "$1" "$USD"; }
num() { awk '{print $1}'; }
q() { [ -n "$DB" ] && psql "$DB" -At -F '|' -c "$1" 2>/dev/null || true; }

echo "SwayKeys $KEYS"
echo "  ETH held by the contract (key reserves + everything not claimed yet): $(fmt "$(CAST balance "$KEYS" --rpc-url "$RPC")")"
TREASURY="$(CAST call "$KEYS" 'treasury()(address)' --rpc-url "$RPC")"
read -r -a T < <(CAST call "$KEYS" 'claimable(address,address[])(uint256,uint256,uint256,uint256)' "$TREASURY" '[]' --rpc-url "$RPC" | num | tr '\n' ' '; echo) || true
echo "Treasury $TREASURY"
echo "  protocol fees waiting to be claimed: $(fmt "${T[3]}")"
echo "  ETH in the wallet:                   $(fmt "$(CAST balance "$TREASURY" --rpc-url "$RPC")")"

for A in "$@"; do
  [[ "$A" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "skipping $A: not an address"; continue; }
  a="$(echo "$A" | tr 'A-F' 'a-f')"
  echo
  echo "Wallet $a"
  # Holder rewards are settled per market: list the markets this wallet holds keys in (from the indexer's mirror).
  SUBJ="$(q "SELECT string_agg(DISTINCT k.subject, ',') FROM \"Holding\" h JOIN \"KeyMarket\" k ON k.id = h.\"marketId\" WHERE h.address = '$a' AND h.units > 0")"
  read -r -a E < <(CAST call "$KEYS" 'claimable(address,address[])(uint256,uint256,uint256,uint256)' "$a" "[${SUBJ}]" --rpc-url "$RPC" | num | tr '\n' ' '; echo) || true
  TOTAL="$(node -e 'console.log(process.argv.slice(1).reduce((s,x)=>s+BigInt(x),0n).toString())' "${E[@]}")"
  echo "  waiting to be claimed: $(fmt "$TOTAL")"
  echo "    creator fees $(fmt "${E[0]}") · holder rewards $(fmt "${E[1]}") · referral $(fmt "${E[2]}") · protocol $(fmt "${E[3]}")"
  echo "  ETH in the wallet:     $(fmt "$(CAST balance "$a" --rpc-url "$RPC")")"
  ROW="$(q "SELECT count(*) FILTER (WHERE \"isBuy\"), coalesce(sum(\"totalWei\") FILTER (WHERE \"isBuy\"),0)::text, count(*) FILTER (WHERE NOT \"isBuy\"), coalesce(sum(\"totalWei\") FILTER (WHERE NOT \"isBuy\"),0)::text, coalesce(sum(\"creatorFeeWei\"+\"protocolFeeWei\"+\"holderFeeWei\"+\"referralFeeWei\"),0)::text FROM \"Trade\" WHERE trader = '$a'")"
  if [ -n "$ROW" ]; then
    IFS='|' read -r NB PAID NS GOT FEES <<<"$ROW"
    echo "  key trades: $NB buys paid $(fmt "$PAID"), $NS sells received $(fmt "$GOT")"
    echo "    fees inside those trades: $(fmt "$FEES") (credited to creators, holders, referrers and the treasury)"
  fi
done
echo
echo "Claim from the Wallet page (each wallet: Claim), or the treasury from its own wallet. Nothing was sent."
