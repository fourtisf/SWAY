#!/usr/bin/env bash
# Sends Sway's fees to the operator wallet (the one that pays Sway's gas). Run as root after sway-update:
#   bash /srv/sway/deploy/claim-fees.sh [0xOldTreasury …]
#  1. When the treasury isn't the operator and the operator key owns SwayKeys, it offers to make the operator the
#     treasury, so every later protocol fee is credited there (stakers keep their half).
#  2. It claims everything the operator's address has earned in SwayKeys (protocol fees as treasury, plus its own
#     creator, holder and referral fees) into the operator wallet.
#  3. Fees already credited to an older treasury (the current one, the one in the deployment file, ADMIN_ADDRESS, or
#     addresses given as arguments) can only be claimed by that wallet: it offers to send it a little gas from the
#     operator and prints the steps to claim and forward them.
# It shows everything first and asks before each transaction. Stakers' fees are theirs and are never touched.
set -euo pipefail
ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
ENV="${SWAY_ENV:-$ROOT/.env}"
get() { sed -n "s/^$1=//p" "$ENV" | tail -1 | sed 's/^"\(.*\)"$/\1/'; }
APP_USER="$(stat -c %U "$ROOT")"
if [ "$(id -u)" = 0 ] && [ "$APP_USER" != root ]; then
  CAST() { sudo -u "$APP_USER" -H env PATH="/home/$APP_USER/.foundry/bin:/usr/local/bin:/usr/bin:/bin" cast "$@"; }
else
  CAST() { env PATH="$HOME/.foundry/bin:$PATH" cast "$@"; }
fi
lc() { tr 'A-F' 'a-f'; }
num() { awk '{print $1}'; }
eth() { echo "$(CAST from-wei "$1") ETH"; }
ask() { local a=""; read -r -p "$1 Type yes: " a || true; [ "$a" = yes ]; }

RPC="$(get RPC_URL)"
KEYS="$(get SWAY_KEYS_ADDRESS)"
CHAIN="$(get CHAIN_ID)"
PK="$(get OPERATOR_PRIVATE_KEY)"
DB="$(get DATABASE_URL | sed 's/?.*//')"
EXPLORER="$(get EXPLORER_URL)"
[ "$CHAIN" = 4663 ] && EXPLORER="${EXPLORER:-https://robinhoodchain.blockscout.com}"
[ -n "$KEYS" ] || { echo "SWAY_KEYS_ADDRESS isn't set in $ENV" >&2; exit 1; }
[ -n "$PK" ] || { echo "OPERATOR_PRIVATE_KEY isn't set in $ENV" >&2; exit 1; }
GOT="$(CAST chain-id --rpc-url "$RPC" || true)"
[ "$GOT" = "$CHAIN" ] || { echo "the RPC at $RPC answers chain '$GOT', expected $CHAIN" >&2; exit 1; }

OP="$(CAST wallet address --private-key "$PK" | lc)"
OWNER="$(CAST call "$KEYS" 'owner()(address)' --rpc-url "$RPC" | lc)"
TREASURY="$(CAST call "$KEYS" 'treasury()(address)' --rpc-url "$RPC" | lc)"
claimable() { CAST call "$KEYS" 'claimable(address,address[])(uint256,uint256,uint256,uint256)' "$1" "[$2]" --rpc-url "$RPC" | num | tr '\n' ' '; }
total() { node -e 'console.log(process.argv.slice(1).reduce((s,x)=>s+BigInt(x),0n).toString())' "$@"; }
# Holder rewards are settled per market: the markets the operator's address holds keys in (indexer mirror).
SUBJ=""
[ -n "$DB" ] && SUBJ="$(psql "$DB" -At -c "SELECT coalesce(string_agg(DISTINCT k.subject, ','), '') FROM \"Holding\" h JOIN \"KeyMarket\" k ON k.id = h.\"marketId\" WHERE h.address = '$OP' AND h.units > 0" 2>/dev/null || true)"

read -r -a E < <(claimable "$OP" "$SUBJ"; echo) || true
OP_TOTAL="$(total "${E[@]}")"
echo "SwayKeys  $KEYS (owner $OWNER)"
echo "Operator  $OP"
echo "  ETH in the wallet:        $(eth "$(CAST balance "$OP" --rpc-url "$RPC")")"
echo "  earned, waiting to claim: $(eth "$OP_TOTAL")  (creator $(eth "${E[0]}"), holder $(eth "${E[1]}"), referral $(eth "${E[2]}"), protocol $(eth "${E[3]}"))"
# Treasuries other than the operator that may still hold fees: the current one, the one set at deploy, the admin.
OLD=()
DEPLOYED="$(node -e 'try{console.log(require(process.argv[1]).treasury||"")}catch{}' "$ROOT/contracts/deployments/$CHAIN.json" | lc)"
for A in "$TREASURY" "$DEPLOYED" "$(get ADMIN_ADDRESS | lc)" "$@"; do
  A="$(echo "$A" | lc)"
  [[ "$A" =~ ^0x[0-9a-f]{40}$ ]] && [ "$A" != "$OP" ] && [[ " ${OLD[*]} " != *" $A "* ]] && OLD+=("$A")
done
old_fees() { local t; read -r -a t < <(claimable "$1" ""; echo) || true; echo "${t[3]:-0}"; }
if [ "$TREASURY" = "$OP" ]; then echo "Treasury  the operator wallet: protocol fees are credited to it"; else echo "Treasury  $TREASURY"; fi
for A in "${OLD[@]}"; do
  echo "Old treasury $A: $(eth "$(old_fees "$A")") protocol fees to claim, $(eth "$(CAST balance "$A" --rpc-url "$RPC")") in the wallet"
done
echo

# 1. Later fees: make the operator the treasury.
if [ "$TREASURY" != "$OP" ]; then
  if [ "$OWNER" = "$OP" ]; then
    if ask "1/3 Make the operator wallet the treasury, so later protocol fees are credited to it?"; then
      CAST send "$KEYS" 'setTreasury(address)' "$OP" --private-key "$PK" --rpc-url "$RPC" >/dev/null
      echo "    done: the treasury is now $OP"
    else
      echo "    skipped"
    fi
  else
    echo "1/3 SwayKeys belongs to $OWNER, not the operator: that wallet can call setTreasury($OP)"
    [ -n "$EXPLORER" ] && echo "    $EXPLORER/address/$KEYS?tab=write_contract"
  fi
fi

# 2. Claim what the operator's address has earned.
read -r -a E < <(claimable "$OP" "$SUBJ"; echo) || true
OP_TOTAL="$(total "${E[@]}")"
if [ "$OP_TOTAL" != 0 ]; then
  if ask "2/3 Claim $(eth "$OP_TOTAL") into the operator wallet?"; then
    CAST send "$KEYS" 'claim(address[])' "[$SUBJ]" --private-key "$PK" --rpc-url "$RPC" >/dev/null
    echo "    claimed: the operator wallet now has $(eth "$(CAST balance "$OP" --rpc-url "$RPC")")"
  else
    echo "    skipped"
  fi
else
  echo "2/3 Nothing waiting for the operator's address yet"
fi

# 3. Fees credited to an older treasury: only that wallet can claim them.
LEFT=0
for A in "${OLD[@]}"; do
  F="$(old_fees "$A")"
  [ "$F" != 0 ] || continue
  LEFT=1
  echo "3/3 $(eth "$F") is credited to $A; only that wallet can claim it."
  # Enough for the claim and the transfer on: 800k gas at today's gas price, at least 0.00002 ETH.
  GAS="$(node -e 'const g=BigInt(process.argv[1])*800000n;console.log((g>20000000000000n?g:20000000000000n).toString())' "$(CAST gas-price --rpc-url "$RPC")")"
  if [ "$(CAST balance "$A" --rpc-url "$RPC")" = 0 ] && ask "    It has no ETH for gas. Send it $(eth "$GAS") from the operator wallet?"; then
    CAST send "$A" --value "$GAS" --private-key "$PK" --rpc-url "$RPC" >/dev/null
    echo "    sent"
  fi
  echo "    Then, in the wallet app that holds $A (MetaMask, Bitget, Rabby…):"
  echo "      a. open ${EXPLORER:-the explorer}/address/$KEYS?tab=write_contract"
  echo "      b. Connect wallet → pick $A → claim → subjects: []  → Write, and confirm"
  echo "      c. send the ETH from $A to the operator $OP (the wallet's Max button leaves the gas)"
done
[ "$LEFT" = 1 ] || echo "3/3 No fees left on an older treasury"
echo
echo "Stakers' fees stay with stakers (harvest() pays them). Check again: bash $ROOT/deploy/claim-fees.sh"
