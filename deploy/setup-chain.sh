#!/usr/bin/env bash
# Turns on trading (buy/sell keys): Robinhood Chain testnet settings, an operator wallet, the contracts, then a
# redeploy. Run as root, and again after funding the wallet; finished steps are skipped:
#   bash /srv/sway/deploy/setup-chain.sh
# The operator key is written to .env only (readable by the app user); it is never printed.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root: bash $0" >&2; exit 1; }
ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
ENV="$ROOT/.env"
APP_USER="$(stat -c %U "$ROOT")"
[ -f "$ENV" ] || { echo "no $ENV: run deploy/install-server.sh first" >&2; exit 1; }
[ "$APP_USER" != root ] || { echo "$ROOT is owned by root; expected the app user" >&2; exit 1; }

get() { sed -n "s/^$1=//p" "$ENV" | tail -1 | sed 's/^"\(.*\)"$/\1/'; }
blank() { local v; v="$(get "$1")"; [ -z "$v" ] || [ "$v" = FILL_ME ]; }
# node writes values verbatim (keys and names would trip sed); values with spaces are quoted.
put() {
  K="$1" V="$2" node -e '
    const fs = require("fs"); const f = process.argv[1]; let s = fs.readFileSync(f, "utf8");
    const v = /\s/.test(process.env.V) ? JSON.stringify(process.env.V) : process.env.V;
    const re = new RegExp(`^${process.env.K}=.*$`, "m"); const line = `${process.env.K}=${v}`;
    s = re.test(s) ? s.replace(re, () => line) : s.replace(/\n?$/, `\n${line}\n`);
    fs.writeFileSync(f, s);' "$ENV"
}
as_app() { sudo -iu "$APP_USER" "$@"; }

echo "1/5 Robinhood Chain testnet settings"
blank CHAIN_ID && put CHAIN_ID 46630
blank CHAIN_NAME && put CHAIN_NAME "Robinhood Chain Testnet"
blank RPC_URL && put RPC_URL https://rpc.testnet.chain.robinhood.com
blank EXPLORER_URL && put EXPLORER_URL https://explorer.testnet.chain.robinhood.com
blank FAUCET_URL && put FAUCET_URL https://faucet.testnet.chain.robinhood.com
[ "$(get CHAIN_ID)" != 4663 ] || { echo "CHAIN_ID is Robinhood Chain mainnet: the contracts are unaudited, use the testnet" >&2; exit 1; }
RPC="$(get RPC_URL)"
echo "    chain $(get CHAIN_ID) · $RPC"

echo "2/5 Foundry (forge, cast) for $APP_USER"
if ! as_app test -x .foundry/bin/forge; then
  as_app bash -c 'curl -sSL https://foundry.paradigm.xyz | bash >/dev/null && ~/.foundry/bin/foundryup'
fi
CAST() { as_app env PATH="/home/$APP_USER/.foundry/bin:/usr/bin:/bin" cast "$@"; }

echo "3/5 Operator wallet"
if blank OPERATOR_PRIVATE_KEY; then
  put OPERATOR_PRIVATE_KEY "0x$(openssl rand -hex 32)"
  echo "    created a new operator key (saved in .env, not shown)"
fi
blank ISSUER_PRIVATE_KEY && put ISSUER_PRIVATE_KEY "$(get OPERATOR_PRIVATE_KEY)"
chown "$APP_USER:$APP_USER" "$ENV"
chmod 600 "$ENV"
ADDR="$(CAST wallet address --private-key "$(get OPERATOR_PRIVATE_KEY)")"
echo "    operator address: $ADDR"

echo "4/5 Contracts"
if blank SWAY_KEYS_ADDRESS; then
  BAL="$(CAST balance "$ADDR" --rpc-url "$RPC")"
  # Deploying all contracts and opening the first markets needs a little test ETH.
  if [ "$(node -e 'console.log(BigInt(process.argv[1]) >= 10n ** 16n ? 1 : 0)' "$BAL")" != 1 ]; then
    cat <<EOF

    The operator wallet needs test ETH (at least 0.01) before the contracts can be deployed:
      1. open $(get FAUCET_URL)
      2. paste this address: $ADDR
      3. when the ETH arrives, run again:  bash $ROOT/deploy/setup-chain.sh
EOF
    exit 0
  fi
  echo "    balance ok, deploying (a few minutes)"
  as_app env RPC="$RPC" PK="$(get OPERATOR_PRIVATE_KEY)" bash -c \
    "cd '$ROOT/contracts' && ~/.foundry/bin/forge script script/Deploy.s.sol:Deploy --rpc-url \"\$RPC\" --private-key \"\$PK\" --broadcast --slow"
  bash "$ROOT/scripts/apply-deployment.sh" "$(get CHAIN_ID)"
  chown "$APP_USER:$APP_USER" "$ENV"
  chmod 600 "$ENV"
else
  echo "    already deployed: SwayKeys $(get SWAY_KEYS_ADDRESS)"
fi

echo "5/5 Build and restart"
bash "$ROOT/deploy/update.sh"
cat <<EOF

Trading is on. To buy a key:
  1. Connect X, then create a Sway wallet (or connect MetaMask) and copy its address from Wallet → Deposit
  2. Get test ETH for it at $(get FAUCET_URL)
  3. Open a creator's profile → Buy, pick an amount, confirm
To sell: the creator's profile or Wallet → Your keys → Sell.
EOF
