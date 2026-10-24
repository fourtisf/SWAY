# Deploying Sway to a VPS (swayfamily.com)

Ubuntu 24.04, one machine: nginx (TLS) → Next.js on :3000 and the API on :4000, workers, PostgreSQL and
Redis on the same host, all apps under PM2 as the `sway` user in `/srv/sway`. Contracts are unaudited: deploy
to a **testnet** (the API, the workers and `Deploy.s.sol` refuse Robinhood Chain mainnet).

Before you start: the domain's `A` record points at the server (`@` → server IP, `www` → CNAME to the domain).

## 1. App user and code (as root)

```bash
adduser --disabled-password --gecos '' sway
git clone -b claude/new-session-rwx8b5 https://github.com/fourtisf/SWAY.git /srv/sway
cd /srv/sway && git submodule update --init --recursive
```

## 2. Server setup (as root)

```bash
DOMAIN=swayfamily.com EMAIL=you@example.com bash /srv/sway/deploy/install-server.sh
```

Installs Node 22, pnpm, PM2, PostgreSQL, Redis, nginx, the Let's Encrypt certificate (www included), the
firewall (SSH + HTTP/HTTPS only), PM2 on boot and the nightly backup cron, and writes `/srv/sway/.env` with a
database password, session secret and VAPID keys already filled in.

## 3. Fill in `.env` (as sway)

```bash
sudo -iu sway nano /srv/sway/.env
```

| Key | Value |
|---|---|
| `CHAIN_ID`, `CHAIN_NAME`, `RPC_URL`, `EXPLORER_URL` | The Robinhood Chain **testnet** values from its official docs. |
| `OPERATOR_PRIVATE_KEY` | A new key used only for Sway, funded with testnet ETH. It deploys the contracts below and signs members' permits (free); new members cost it no gas, because each member's market opens with its first buy, paid by the buyer. |
| `ISSUER_PRIVATE_KEY` | Genesis pass minter (can be the same key on testnet). |
| `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_BEARER_TOKEN` | Your X developer app. Its callback URL must be `https://swayfamily.com/api/auth/x/callback`. Without them nobody can sign in: dev sign-in is off in production. |
| `ADMIN_HANDLES` | Your X handle (comma-separated list) for `/admin`. |
| `WALLETCONNECT_PROJECT_ID` | Optional, from cloud.reown.com: enables WalletConnect in the wallet picker. |
| `X_LAUNCH_POST_ID`, `FAUCET_URL`, `GAS_DRIP_WEI` | Optional. Keep `GAS_DRIP_WEI=0` unless you want to pay new members' gas. |
| `SPONSOR_ONBOARDING` | Optional, default 0. 1 = the operator pays to open every member's market at sign-up (the old flow). |

Never paste these keys into chats or commit them; `.env` is git-ignored and readable by `sway` only.

To turn on Connect X later without editing the file by hand: `bash /srv/sway/deploy/set-x-keys.sh` (as root) asks for
the Client ID, Client Secret, Bearer Token and your admin handle, saves them and redeploys.
If X shows "Something went wrong", run `bash /srv/sway/deploy/check-x.sh` (as root): it checks the keys with X
and the callback URL, and prints the exact values for the app's User authentication settings.

## 4. Deploy the contracts (turns on buying and selling keys)

```bash
bash /srv/sway/deploy/setup-chain.sh      # as root; run it again after funding the wallet
```

It fills in the Robinhood Chain testnet settings, installs Foundry, creates the operator wallet (key saved in
`.env`, never printed) and shows its address. Send test ETH to that address from the faucet, run the script again:
it deploys the contracts, writes their addresses into `.env` and redeploys the site. Members who joined before
the contracts existed open their market with "Open your key market"; fan markets opened earlier are opened onchain
by submitting the handle again in Admin → Markets.

**Mainnet** (real ETH): `bash /srv/sway/deploy/setup-chain.sh --mainnet`. It asks you to type I UNDERSTAND and for
your own wallet as the contracts' owner, checks the RPC answers chain 4663, deploys without the launchpad (add it
with `bash /srv/sway/deploy/setup-launchpad.sh`: it rehearses a graduation into the real Uniswap V2 on a fork, then
deploys; graduated tokens move into Uniswap by themselves) (and
without staking until $SWAY exists: add it with `bash /srv/sway/deploy/setup-staking.sh`, which reads the token's
supply, proposes levels at 0.01/0.1/0.5/1% of it, asks before deploying, and turns it on for key trades when the
operator owns SwayKeys; otherwise press **Admin → Contracts → Turn on staking** with the owner wallet), and turns browser-made wallets off: people trade with wallet apps. Then accept
ownership on each contract from your wallet in **Admin → Contracts** (MetaMask on the owner account, a little ETH for
gas). Optional: `bash /srv/sway/deploy/verify-contracts.sh` publishes the source on the explorer (no transaction).
Read `docs/SECURITY_REVIEW.md` first.

The same by hand:


```bash
sudo -iu sway bash -c 'curl -L https://foundry.paradigm.xyz | bash && ~/.foundry/bin/foundryup'
sudo -u sway -H bash -lc 'cd /srv/sway/contracts && set -a && . ../.env && set +a && \
  ~/.foundry/bin/forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC_URL" \
    --private-key "$OPERATOR_PRIVATE_KEY" --broadcast --slow && \
  bash ../scripts/apply-deployment.sh'
```

With no `SWAY_TOKEN` set, a test `$SWAY` token is deployed too. The addresses and the indexer start block are
written into `.env`.

## 5. Build and start (run again after every update)

```bash
bash /srv/sway/deploy/update.sh      # as root; afterwards just: sway-update
```

It never asks for keys (they stay in `.env`). Run as root it installs the `sway-update` shortcut and builds as
the `sway` user.

Pulls the branch, installs, migrates the database, builds and (re)starts `sway-api`, `sway-workers` and
`sway-web` under PM2. It refuses to run while `.env` still has `FILL_ME` values.

## 6. Check

```bash
sudo -iu sway pm2 status
curl -s http://127.0.0.1:4100/healthz          # workers: db, redis, rpc, indexer lag
curl -sI https://swayfamily.com | head -1        # HTTP/2 200
sudo -iu sway pm2 logs --lines 50
```

Then open https://swayfamily.com, sign in with X, create the Sway wallet and buy a key.

## Later

- **Updates:** push to the branch, then `sway-update` (as root).
- **Where did the ETH go:** `bash /srv/sway/deploy/audit-wallets.sh <handle or 0x…>…` (read-only): deposits, trades, fees and what is left to claim; `deploy/check-earnings.sh 0x…` shows only what is claimable.
- **Backups:** `/var/backups/sway` (nightly, 14 days). Copy them off the machine.
- **Certificates:** renewed by certbot's timer; nginx reloads after each renewal.
- **Mainnet:** `setup-chain.sh --mainnet` (see step 4) after reading `docs/SECURITY_REVIEW.md`; a third-party audit is still recommended.
