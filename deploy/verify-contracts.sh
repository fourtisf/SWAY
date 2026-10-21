#!/usr/bin/env bash
# Publishes the deployed contracts' source code on the block explorer (Blockscout), so anyone can read what they
# run and the explorer's Contract → Write tab works (acceptOwnership). Sends no transaction and costs nothing.
# Run as root after setup-chain.sh has deployed:
#   bash /srv/sway/deploy/verify-contracts.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root: bash $0" >&2; exit 1; }
ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
ENV="$ROOT/.env"
APP_USER="$(stat -c %U "$ROOT")"
get() { sed -n "s/^$1=//p" "$ENV" | tail -1 | sed 's/^"\(.*\)"$/\1/'; }

CHAIN="$(get CHAIN_ID)"
EXPLORER="$(get EXPLORER_URL)"
EXPLORER="${EXPLORER%/}"
RUN="$ROOT/contracts/broadcast/Deploy.s.sol/$CHAIN/run-latest.json"
[ -n "$EXPLORER" ] || { echo "EXPLORER_URL is empty in $ENV" >&2; exit 1; }
[ -f "$RUN" ] || { echo "no deployment record for chain $CHAIN at $RUN: deploy with setup-chain.sh first" >&2; exit 1; }
CODE="$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$EXPLORER/api/v2/stats" || true)"
if [ "$CODE" != 200 ]; then
  echo "can't reach the explorer at $EXPLORER (HTTP '$CODE'): check EXPLORER_URL in $ENV" >&2
  [ "$CHAIN" = 4663 ] && echo "Robinhood Chain mainnet's explorer is https://robinhoodchain.blockscout.com" >&2
  exit 1
fi
echo "verifying the contracts of chain $CHAIN on $EXPLORER"

# Constructor arguments come from the deployment record, their types from the compiled artifacts.
cd "$ROOT/contracts"
if ! sudo -u "$APP_USER" -H env PATH="/home/$APP_USER/.foundry/bin:/usr/bin:/bin" RUN="$RUN" CHAIN="$CHAIN" URL="$EXPLORER/api/" \
  node -e '
    const { execFileSync } = require("child_process");
    const fs = require("fs");
    const run = require(process.env.RUN);
    // out/<File>.sol/<Contract>.json; usually File = Contract, but not for contracts declared in other files.
    const artifact = (name) => {
      const dirs = [`${name}.sol`, ...fs.readdirSync("out")];
      const dir = dirs.find((d) => fs.existsSync(`out/${d}/${name}.json`));
      if (!dir) throw new Error(`no build artifact for ${name}: run forge build in contracts/`);
      return JSON.parse(fs.readFileSync(`out/${dir}/${name}.json`, "utf8"));
    };
    let failed = 0;
    for (const t of run.transactions.filter((x) => x.transactionType === "CREATE")) {
      const art = artifact(t.contractName);
      const [path] = Object.keys(art.metadata.settings.compilationTarget);
      const inputs = art.abi.find((x) => x.type === "constructor")?.inputs ?? [];
      const args = ["verify-contract", t.contractAddress, `${path}:${t.contractName}`, "--chain", process.env.CHAIN,
        "--verifier", "blockscout", "--verifier-url", process.env.URL, "--watch"];
      if (inputs.length) {
        const sig = `constructor(${inputs.map((i) => i.type).join(",")})`;
        args.push("--constructor-args", execFileSync("cast", ["abi-encode", sig, ...t.arguments]).toString().trim());
      }
      console.log(`\n${t.contractName} ${t.contractAddress}`);
      try {
        execFileSync("forge", args, { stdio: "inherit" });
      } catch {
        failed++;
      }
    }
    if (failed) {
      console.error(`\n${failed} contract(s) not verified (see above; one that was verified before reports an error too).`);
      process.exit(1);
    }'; then
  echo "Some contracts weren't verified. Run this again in a minute; send the output if it keeps failing." >&2
  exit 1
fi
echo
echo "Done. Open each contract on $EXPLORER: a verified one shows its code and a Write tab."
