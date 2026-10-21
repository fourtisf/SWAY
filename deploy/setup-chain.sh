#!/usr/bin/env bash
# Turns on trading (buy/sell keys): chain settings, an operator wallet, the contracts, then a redeploy.
# Run as root, and again after funding the wallet; finished steps are skipped:
#   bash /srv/sway/deploy/setup-chain.sh             Robinhood Chain testnet (free test ETH)
#   bash /srv/sway/deploy/setup-chain.sh --mainnet   Robinhood Chain mainnet (real ETH; asks for confirmation
#                                                    and for an owner wallet, or SAME to use one key for both)
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
# sudo -i expands $VARS in the login shell before `env` sets them, so commands that read env vars use this.
as_app_env() { sudo -u "$APP_USER" -H "$@"; }
lower() { tr 'A-F' 'a-f'; }

MAINNET=0
[ "${1:-}" = --mainnet ] && MAINNET=1
MAIN_ID=4663

if [ "$MAINNET" = 1 ]; then
  echo "1/5 Robinhood Chain MAINNET settings"
  if [ "$(get CHAIN_ID)" != "$MAIN_ID" ] && ! blank SWAY_KEYS_ADDRESS; then
    echo "Contracts for chain $(get CHAIN_ID) are already set in .env. Moving to mainnet would mix their trades into" >&2
    echo "the mainnet mirror: the onchain tables need a clean reset first (ask before running this again)." >&2
    exit 1
  fi
  if [ "$(get SWAY_ENABLE_MAINNET)" != 1 ]; then
    echo
    echo "    MAINNET uses real ETH. The Sway contracts have had an internal security review"
    echo "    (docs/SECURITY_REVIEW.md) but no third-party audit: a bug could lose users' funds for good,"
    echo "    and onchain trades can't be reversed. The site shows an 'unaudited' notice on every trade and"
    echo "    only lets people use wallet apps there."
    read -rp "    Type I UNDERSTAND to continue: " OK
    [ "$OK" = "I UNDERSTAND" ] || { echo "stopped" >&2; exit 1; }
  fi
  put CHAIN_ID "$MAIN_ID"
  put CHAIN_NAME "Robinhood Chain"
  case "$(get RPC_URL)" in *mainnet*) ;; *) put RPC_URL https://rpc.mainnet.chain.robinhood.com ;; esac
  case "$(get EXPLORER_URL)" in *mainnet*|*blockscout*) ;; *) put EXPLORER_URL https://explorer.mainnet.chain.robinhood.com ;; esac
  put FAUCET_URL ""
  put SWAY_ENABLE_MAINNET 1
  if blank ADMIN_ADDRESS && [ "$(get SINGLE_KEY)" != 1 ]; then
    echo "    The contracts' owner (pause, settings, treasury) is best kept in YOUR wallet, apart from the server's key."
    read -rp "    Owner wallet address (0x...), or SAME to use one key for owner and operator: " ADMIN_IN
    if [ "$ADMIN_IN" = SAME ]; then
      echo "    One key: it will sit on this server and can pause, change the treasury and hand over the contracts."
      echo "    If the server is ever broken into, whoever gets it controls Sway's settings and future fees."
      read -rp "    Type ONE KEY to confirm: " OK1
      [ "$OK1" = "ONE KEY" ] || { echo "stopped" >&2; exit 1; }
      read -rsp "    Paste that wallet's private key (hidden; Enter = create a new one): " PK_IN; echo
      PK_IN="${PK_IN#0x}"
      if [ -n "$PK_IN" ]; then
        [[ "$PK_IN" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "that is not a private key (64 hex characters)" >&2; exit 1; }
        put OPERATOR_PRIVATE_KEY "0x$PK_IN"
        put ISSUER_PRIVATE_KEY "0x$PK_IN"
      fi
      put SINGLE_KEY 1
    else
      [[ "$ADMIN_IN" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "that is not an address" >&2; exit 1; }
      put ADMIN_ADDRESS "$ADMIN_IN"
    fi
  fi
else
  echo "1/5 Robinhood Chain testnet settings"
  blank CHAIN_ID && put CHAIN_ID 46630
  blank CHAIN_NAME && put CHAIN_NAME "Robinhood Chain Testnet"
  blank RPC_URL && put RPC_URL https://rpc.testnet.chain.robinhood.com
  blank EXPLORER_URL && put EXPLORER_URL https://explorer.testnet.chain.robinhood.com
  blank FAUCET_URL && put FAUCET_URL https://faucet.testnet.chain.robinhood.com
  [ "$(get CHAIN_ID)" != "$MAIN_ID" ] || { echo "CHAIN_ID is mainnet: run with --mainnet" >&2; exit 1; }
fi
RPC="$(get RPC_URL)"
echo "    chain $(get CHAIN_ID) · $RPC"

echo "2/5 Foundry (forge, cast) for $APP_USER"
if ! as_app test -x .foundry/bin/forge; then
  as_app bash -c 'curl -sSL https://foundry.paradigm.xyz | bash >/dev/null && ~/.foundry/bin/foundryup'
fi
CAST() { as_app_env env PATH="/home/$APP_USER/.foundry/bin:/usr/bin:/bin" cast "$@"; }

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
GOT="$(CAST chain-id --rpc-url "$RPC" || true)"
[ "$GOT" = "$(get CHAIN_ID)" ] || { echo "the RPC at $RPC answers chain '$GOT', expected $(get CHAIN_ID): fix RPC_URL in .env" >&2; exit 1; }
if [ "$MAINNET" = 1 ] && [ "$(get SINGLE_KEY)" != 1 ] && [ "$(echo "$ADDR" | lower)" = "$(get ADMIN_ADDRESS | lower)" ]; then
  echo "the owner wallet is the server's operator key: run again and answer SAME to keep one key on purpose" >&2
  put ADMIN_ADDRESS ""
  exit 1
fi

echo "4/5 Contracts"
if blank SWAY_KEYS_ADDRESS; then
  BAL="$(CAST balance "$ADDR" --rpc-url "$RPC")"
  # Deploying the contracts and opening the first markets needs a little ETH (0.01 test ETH, 0.005 real ETH).
  if [ "$MAINNET" = 1 ]; then MIN=5000000000000000; else MIN=10000000000000000; fi
  if [ "$(node -e 'console.log(BigInt(process.argv[1]) >= BigInt(process.argv[2]) ? 1 : 0)' "$BAL" "$MIN")" != 1 ]; then
    echo
    if [ "$MAINNET" = 1 ]; then
      echo "    The operator wallet pays gas for the deploy and for opening markets."
      echo "    Send it at least 0.005 ETH on Robinhood Chain: $ADDR"
      echo "    then run again:  bash $ROOT/deploy/setup-chain.sh --mainnet"
    else
      echo "    The operator wallet needs test ETH (at least 0.01) before the contracts can be deployed:"
      echo "      1. open $(get FAUCET_URL)"
      echo "      2. paste this address: $ADDR"
      echo "      3. when the ETH arrives, run again:  bash $ROOT/deploy/setup-chain.sh"
    fi
    exit 0
  fi
  echo "    balance ok, deploying (a few minutes)"
  as_app_env env RPC="$RPC" PK="$(get OPERATOR_PRIVATE_KEY)" ALLOW_MAINNET="$MAINNET" ALLOW_SINGLE_KEY="$(get SINGLE_KEY)" OWNER="$(get ADMIN_ADDRESS)" bash -lc \
    "cd '$ROOT/contracts' && if [ -n \"\$OWNER\" ]; then export ADMIN=\"\$OWNER\"; fi; ~/.foundry/bin/forge script script/Deploy.s.sol:Deploy --rpc-url \"\$RPC\" --private-key \"\$PK\" --broadcast --slow"
  bash "$ROOT/scripts/apply-deployment.sh" "$(get CHAIN_ID)"
  chown "$APP_USER:$APP_USER" "$ENV"
  chmod 600 "$ENV"
else
  echo "    already deployed: SwayKeys $(get SWAY_KEYS_ADDRESS)"
fi

echo "5/5 Build and restart"
bash "$ROOT/deploy/update.sh"

if [ "$MAINNET" = 1 ] && [ "$(get SINGLE_KEY)" = 1 ]; then
  echo
  echo "Mainnet trading is on, with one key ($ADDR) as owner and operator."
  echo "  Back up $ENV somewhere safe and keep that key's seed/private key offline too."
  echo "People buy and sell with wallet apps (MetaMask, Coinbase Wallet, Rabby...) holding ETH on Robinhood Chain."
  exit 0
fi
if [ "$MAINNET" = 1 ]; then
  echo
  echo "Mainnet trading is on. Two things only you can do:"
  echo "  1. Accept ownership with your owner wallet ($(get ADMIN_ADDRESS)): on $(get EXPLORER_URL), open each"
  echo "     contract below → Contract → Write → connect that wallet → acceptOwnership."
  grep -E '^(SWAY_KEYS|FAN_ESCROW|GENESIS_PASS|SWAY_STAKING|LAUNCHPAD)_ADDRESS=0x' "$ENV" | sed 's/^/       /'
  echo "  2. Back up $ENV somewhere safe: it holds the operator key that pays gas for new markets."
  echo "People buy and sell with wallet apps (MetaMask, Coinbase Wallet, Rabby...) holding ETH on Robinhood Chain."
  exit 0
fi
echo
echo "Trading is on. To buy a key:"
echo "  1. Connect X, then create a Sway wallet (or connect MetaMask) and copy its address from Wallet → Deposit"
echo "  2. Get test ETH for it at $(get FAUCET_URL)"
echo "  3. Open a creator's profile → Buy, pick an amount, confirm"
echo "To sell: the creator's profile or Wallet → Your keys → Sell."
