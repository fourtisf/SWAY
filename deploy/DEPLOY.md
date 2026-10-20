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
| `OPERATOR_PRIVATE_KEY` | A new key used only for Sway, funded with testnet ETH (opens markets, sets referrers). Also used to deploy below. |
| `ISSUER_PRIVATE_KEY` | Genesis pass minter (can be the same key on testnet). |
| `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_BEARER_TOKEN` | Your X developer app. Its callback URL must be `https://swayfamily.com/api/auth/x/callback`. Without them nobody can sign in: dev sign-in is off in production. |
| `ADMIN_HANDLES` | Your X handle (comma-separated list) for `/admin`. |
| `WALLETCONNECT_PROJECT_ID` | Optional, from cloud.reown.com: enables WalletConnect in the wallet picker. |
| `X_LAUNCH_POST_ID`, `FAUCET_URL`, `GAS_DRIP_WEI` | Optional. |

Never paste these keys into chats or commit them; `.env` is git-ignored and readable by `sway` only.

To turn on Connect X later without editing the file by hand: `bash /srv/sway/deploy/set-x-keys.sh` (as root) asks for
the Client ID, Client Secret, Bearer Token and your admin handle, saves them and redeploys.
If X shows "Something went wrong", run `bash /srv/sway/deploy/check-x.sh` (as root): it checks the keys with X
and the callback URL, and prints the exact values for the app's User authentication settings.

## 4. Deploy the contracts (as sway, once per chain)

```bash
sudo -iu sway bash -c 'curl -L https://foundry.paradigm.xyz | bash && ~/.foundry/bin/foundryup'
sudo -iu sway bash -c 'cd /srv/sway/contracts && set -a && . ../.env && set +a && \
  ~/.foundry/bin/forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC_URL" \
    --private-key "$OPERATOR_PRIVATE_KEY" --broadcast --slow && \
  bash ../scripts/apply-deployment.sh'
```

With no `SWAY_TOKEN` set, a test `$SWAY` token is deployed too. The addresses and the indexer start block are
written into `.env`.

## 5. Build and start (as sway; run again after every update)

```bash
sudo -iu sway bash /srv/sway/deploy/update.sh
```

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

- **Updates:** push to the branch, then `sudo -iu sway bash /srv/sway/deploy/update.sh`.
- **Backups:** `/var/backups/sway` (nightly, 14 days). Copy them off the machine.
- **Certificates:** renewed by certbot's timer; nginx reloads after each renewal.
- **Mainnet:** only after an audit; see the open items in `docs/BUILD_NOTES.md`.
