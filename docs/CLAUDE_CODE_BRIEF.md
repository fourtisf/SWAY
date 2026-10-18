# Sway — build brief for Claude Code

Sway is a SocialFi app on **Robinhood Chain**: every X (Twitter) account gets a public reach score and a creator-key market. Fans buy keys on a bonding curve to enter a creator's room and read holder-only posts. It is modeled on influence.family / friend.tech, with an **open-source scoring model** and a different UI.

`sway-prototype.html` (in this folder) is the **approved UI and behavior reference**. It is a single-file mock: all data is fake, but the bonding-curve math, fee split, scoring function and Genesis weighting are the real formulas and must be reproduced exactly. Match its layout, copy, flows and light X-style theme.

---

## 0. How to start

1. Open `sway-prototype.html` in a browser and click through every page (Home, Explore, Markets, Notifications, Messages, Tasks, Wallet, Leaderboard, Battles, Launchpad, Genesis pass, Open model, a profile, the trade sheet, Connect X).
2. Read this brief end to end.
3. Scaffold the monorepo (section 2), then build in the phase order of section 11. Do not start on contracts deployment to mainnet without an audit (section 12).

---

## 1. Product summary

| Area | What it does |
|---|---|
| Connect X | Read-only X OAuth 2.0. Compute Sway score, reach value, create Sway wallet, open the user's key market (first key auto-minted to the creator, never sellable). Guests can browse everything. |
| Feed | For You / Trending / Following / Latest. Posts up to 500 chars (2,000 with staking level). Visibility: Everyone, Key holders, Subscribers. Like, repost, reply, pinned official post, boosted posts. Live trades ticker under the tabs. |
| Creator keys | Bonding curve in ETH, prices shown in USD. Buy/sell trade sheet with fee breakdown. Holding ≥1 key opens the creator's room (chat) and holder-only posts. |
| Fan markets | Official account can open a key market for an X account that has not joined. Creator fee is escrowed until that account signs in with X and claims. Tabs: Creators, Crypto, Football, Stocks, RWA. |
| Notifications | Trades in your keys, mentions, battle challenges, verified tasks. Unread badge. |
| Messages | Key rooms you hold + direct messages. |
| Tasks / points | Join checklist (sequential unlock), daily tasks, invites. Points feed the airdrop and Genesis rank. |
| Wallet | Balance in USD (cash + key value), Deposit, Withdraw (USDC), one "Earnings to claim" card (creator fees, holder rewards, referral share), keys held, activity log. |
| Leaderboard | Points / Creators (fees earned) / Stakers / Fighters. Podium top 3 + table, Challenge button per row. |
| Battles | 1v1 engagement-rate contest on a theme, optional point stake, spectators back a side with points. |
| Launchpad | "Launch your reach as a token with one switch": bonding-curve token seeded by Sway score, 10% airdropped to the creator's key holders. |
| Genesis pass | 500 soulbound ERC-721 passes minted to the top 500 by points at a snapshot; tokenId = rank; 5% supply pool split by 1/√rank. |
| Open model | Public page: interactive score calculator, the scoring source, contract parameters, fee flow. |

---

## 2. Stack (use the team's standard production stack)

- **Web:** Next.js 14 (App Router), TypeScript, Tailwind (port the prototype's CSS tokens), wagmi + viem for chain reads/writes.
- **API:** Fastify (TypeScript), REST + WebSocket (live trades, notifications, room messages).
- **DB:** PostgreSQL via Prisma. **Redis** for cache, rate limits, pub/sub, BullMQ queues.
- **Workers:** indexer (chain → DB mirror), X API jobs (scoring refresh, task verification, battle reads), points engine, snapshot job.
- **Contracts:** Solidity 0.8.x, Foundry, OpenZeppelin (ReentrancyGuard, Ownable2Step, ERC721, SafeERC20).
- **Wallets:** embedded wallet created at X sign-in (Coinbase CDP embedded wallets or Privy) plus "use my own wallet" via RainbowKit/WalletConnect. One wallet per member, one member per wallet.
- **Hosting:** Hostinger VPS, PM2, Nginx (TLS, websocket upgrade), same as other projects.

Suggested layout:
```
sway/
├─ apps/web          Next.js 14 front end
├─ apps/api          Fastify API + WebSocket
├─ apps/workers      indexer, x-jobs, points, snapshot (BullMQ)
├─ packages/scoring  score.ts (shared by web + workers, see §5)
├─ packages/curve    curve.ts (price, area, quote, fees; shared, see §4)
├─ packages/db       Prisma schema + client
└─ contracts/        SwayKeys, SwayStaking, GenesisPass, FanEscrow, SwayLaunchpad (Foundry)
```

---

## 3. Chain

- Network: **Robinhood Chain mainnet** (influence.family documents chain ID **4663**; explorer `explorer.mainnet.chain.robinhood.com`). Verify both before deploy. Use the testnet for all development.
- Native gas/payment asset: ETH. All prices are stored and settled in ETH (wei); the UI shows USD using an ETH/USD price feed (cache in Redis, refresh ≤ 60s).
- Withdrawals are paid out as **USDC** (swap or bridge path to be confirmed; prototype shows "Withdraw in dollars → USDC").

---

## 4. Creator keys — contract spec (`SwayKeys.sol`)

Exact parameters (also in the prototype's `CURVE` object):

```
K       = 0.0000175 ETH
O       = 2
price(s)        = K * (s + O)^2                         // ETH per key at supply s
cost(a → b)     = K/3 * ((b + O)^3 − (a + O)^3)         // area under curve, buy a→b or sell b→a
1 key   = 100 units; minimum trade = 1 unit (0.01 key)
```
Reference values: first key ≈ 0.0001575 ETH, 10th ≈ 0.00252 ETH, 100th ≈ 0.1821 ETH.

Fees, charged on the curve price (`base`):

| Fee | Rate | Destination |
|---|---|---|
| Creator | 6% | creator (claimable). For unclaimed fan markets → `FanEscrow` |
| Protocol | 2% | half to $SWAY stakers, half to treasury. Cut by staking level: −10% / −25% / −50% / −75% |
| Holders | 1% | **new vs friend.tech**: distributed pro-rata to all current holders of that creator's keys (accumulator / reward-per-key pattern, claimable) |
| Referral | 1% | half to the trader's referrer, half to the creator's referrer; a missing half goes to protocol |

- Buy: user pays `base * (1 + fees)`. Sell: user receives `base * (1 − fees)`.
- Rules: creator's first key is minted to the creator at market open and **can never be sold**; anti-snipe **max 10 keys per wallet for the first 5 minutes** after a market's first trade; all earnings are **pulled** (claim), never pushed.
- Events: `Trade(trader, subject, isBuy, units, ethBase, fees…, supplyAfter)` — the indexer mirrors everything from events.
- The prototype quote function (`quote()` in the HTML) is the source of truth for UI math; port it to `packages/curve` and unit-test it against the contract (fuzz tests in Foundry).

Room access and holder-only posts: always check `balanceOf(subject, user) ≥ 100 units` (on-chain read, cached ≤ 60s). Selling the last key closes access.

---

## 5. Scoring model (`packages/scoring/score.ts`) — public, MIT

```ts
export function score({ followers, er, ppw, age, verified }) {
  const reach = Math.min(1, Math.log10(followers + 1) / Math.log10(5e7));
  const eng   = 1 - Math.exp(-er * 40);     // er = (likes + 2·reposts + 3·replies) / followers, avg per post, last 50 posts
  const cons  = Math.min(1, ppw / 21);      // original posts per week, replies excluded
  const auth  = 0.6 * Math.min(1, age / 6) + 0.4 * (verified ? 1 : 0);   // age in years
  const raw   = 0.35*reach + 0.35*eng + 0.10*cons + 0.20*auth;
  return { score: Math.round(raw * 100), value: 0.42 * followers * raw ** 1.6 * (0.6 + eng) };
}
```
- `value` is the "reach value" in USD shown on cards and the launchpad.
- Same function runs in the worker and on the Open model page. Nothing is weighted by hand.
- Refresh scores on sign-in and on a schedule (respect X API budget; queue + backoff).

---

## 6. Points, tiers, tasks

Points sources:
| Source | Points |
|---|---|
| Sway score | `min(10000, score × 100)` |
| Verified invite (invitee is ≥30 days old, ≥50 followers, has X checkmark, not bot-flagged) | +500 (invitee +100); max 25 credited per day |
| Tasks | per task (see below) |
| Keys held | 400,000 per ETH of current sell value (recounted every minute; own key excluded) |
| Keys traded | 100,000 per ETH of volume (own key excluded) |
| Battles | points won |

Tiers (by points): Murmur 0, Voice 50K, Echo 100K, Chorus 500K, Anthem 2M.

Tasks (verified by reading the user's X account via API — no screenshots, no pasted links): Follow @swaydotfam (1,000), Repost launch post (1,000), Join Telegram (500, skippable), Share Sway card (2,000), daily #SwayDaily post (750), Hold a key you didn't mint (1,500, auto). Join-checklist tasks unlock **in order**. Keep a points **ledger** table (append-only), never edit points by hand.

---

## 7. Battles

- Challenge by handle or open challenge; optional stake from **earned** points only (not score points), max what both sides have earned; friendly (no stake) allowed.
- 24h window, each side publishes one original post with the battle hashtag. 6h after the window, read both posts once from the X API.
- `score = (likes×1 + reposts×2 + replies×3 + quotes×3 + bookmarks×2) ÷ followers`
- Winner takes both stakes − 5% treasury. No post = forfeit; both missing or tie = draw (refund).
- Spectators back a side (≥100 pts); winners split the losing pool pro-rata, 5% to treasury; draw refunds.
- Weekly (Mon 00:00 UTC): 50% of treasury to top 3 fighters by points won (50/30/20).
- Limits: max 3 active battles per account, no rematch vs same account for 7 days, unanswered challenges expire in 48h.

---

## 8. Genesis pass & airdrop

- `GenesisPass.sol`: ERC-721, **soulbound** (transfer/approve revert), max 500, `tokenId = rank`, minted by issuer to each member's Sway wallet. No paid mint, no allowlist.
- Snapshot date in prototype: **2026-10-27 15:00 UTC** (configurable). At cutoff freeze points + wallet addresses, take the snapshot in one DB transaction, publish the list, mint within 24h.
- Pool: 5% of supply split by rank with integer recipe `W(r) = isqrt(10^40 / r)`, `share(r) = W(r) / ΣW`, round down, leftover units one each to largest remainders (lower rank first).
- Eligibility: rank ≤ 500, has a wallet, ≥1 task verified on X, no bot flag, score ≥ reward minimum.

---

## 9. Fan markets (`FanEscrow.sol`)

- Only the official admin can open a market for an X account that hasn't joined; profile labeled **"Unclaimed fan market"** everywhere (prototype shows the copy).
- Creator 6% accrues in escrow per X user ID. When that account signs in with X, the profile + wallet + escrow become theirs. Existing holders keep keys. Rooms open only after claim.
- Keep the disclaimer copy from the prototype on the Markets page and fan profiles, and add a takedown/claim request path.

---

## 10. Data model (Prisma, starting point)

`User` (xId, handle, name, avatar, followers, verified, score, reachValue, memberNo, tier, botFlag) · `Wallet` (address, kind: embedded|external) · `KeyMarket` (subjectAddress, userId?, xId, claimed, category, supplyUnits, priceWei, volumeWei, holders) · `Holding` (marketId, walletId, units, costBasisWei) · `Trade` (txHash, marketId, trader, isBuy, units, baseWei, fees…, supplyAfter, ts) · `Post` (authorId, text, visibility, pinned, boosted, parentId for replies) · `Like` · `Repost` · `Follow` · `Subscription` · `RoomMessage` · `DmThread` · `DmMessage` · `Notification` (type: trade|mention|battle|points, readAt) · `Task` · `TaskCompletion` (status: pending|verified|trusted|revoked) · `Referral` · `PointsLedger` · `Battle` · `BattleBacking` · `Stake` (level, amount, unlockAt) · `EarningsClaim` · `GenesisSnapshot` · `LaunchToken`.

Mirror on-chain state from events (indexer, 1-minute max lag, reorg-safe); the API never trusts client balances.

---

## 11. Build phases

**Phase 1 — core (ship to testnet)**
1. Monorepo, Prisma schema, X OAuth 2.0 (read-only scopes), embedded wallet at sign-in, guest browsing.
2. `packages/curve` + `packages/scoring` with unit tests matching the prototype numbers.
3. `SwayKeys.sol` (+ Foundry tests, fuzz on curve/fees), deploy to testnet, indexer, trade sheet buy/sell end to end.
4. Feed, posts (visibility gating), likes/reposts/replies, profiles, rooms (on-chain access check), DMs.
5. Live trades (WebSocket), notifications, wallet page (USD, claim earnings, deposit, withdraw).
6. UI must match `sway-prototype.html` (light X theme, 3-column desktop, collapsed sidebar ≤1280px, rail hidden ≤1080px, mobile tab bar + drawer + bottom-sheet trade ≤700px).

**Phase 2 — growth**
Tasks + points ledger + tiers, referrals, leaderboard, battles, fan markets + escrow, Open model page, staking ($SWAY levels).

**Phase 3 — launch events**
Genesis snapshot + soulbound mint, Launchpad token contract, airdrop to key holders.

**Phase 4 — recommended additions (not in prototype yet)**
- Post detail page with threaded replies.
- Key price history chart (1H / 1D / 7D) on profiles.
- Portfolio PnL (avg buy price, unrealized/realized PnL per key).
- Shareable Sway card **image** (OG image route) for X posts.
- Referral dashboard, daily streak bonus, watchlist + price alerts, settings (light/dark, profile edit, notification prefs).
- **Creator activity bond:** if a creator posts nothing in their room for 7 days, their 6% fee is redirected to holders until they post again.
- **Anti-dump sell fee:** higher sell fee within 24h of buying, excess paid to holders.
- Live voice rooms for key holders; creator airdrops to holders.

---

## 12. Security & compliance notes

- Contracts are **unaudited** until an audit report is published; keep mainnet behind a flag until then. Use pull payments, ReentrancyGuard, checks-effects-interactions, and admin keys on a multisig with a timelock for parameter changes.
- Rate-limit all X-API-backed endpoints; queue jobs and pause verification gracefully when the X budget runs out (tasks stay open; low-value tasks may be "trusted" then re-checked).
- One account per X user ID; bot/farm flags exclude from rewards (points remain, eligibility removed).
- Keep the in-app disclaimers from the prototype: keys are access, not shares or investments, can lose value; reach value is an in-app estimate; points have no monetary value until announced; staker rewards are variable and may be zero.
- Store only: X id, handle, display name, avatar URL, public metrics used for scoring. Do not store X access tokens beyond the session.

---

## 13. Environment variables (initial)

```
DATABASE_URL=
REDIS_URL=
X_CLIENT_ID=
X_CLIENT_SECRET=
X_BEARER_TOKEN=
X_CALLBACK_URL=
CHAIN_ID=
RPC_URL=
SWAY_KEYS_ADDRESS=
SWAY_STAKING_ADDRESS=
GENESIS_PASS_ADDRESS=
FAN_ESCROW_ADDRESS=
LAUNCHPAD_ADDRESS=
ISSUER_PRIVATE_KEY=        # Genesis minter, keep in a secrets manager
EMBEDDED_WALLET_API_KEY=   # Coinbase CDP or Privy
ETH_USD_FEED_URL=
SNAPSHOT_AT=2026-10-27T15:00:00Z
```

---

## 14. Definition of done (Phase 1)

- A new user can connect X on testnet, sees their score card, has a wallet and an open key market.
- Another user can buy and sell that creator's keys; prices, fees and supply match `packages/curve` to the wei; holder fee accrues and is claimable.
- Holding ≥1 key unlocks the room and holder-only posts; selling the last key re-locks them.
- Live trades and notifications update without refresh.
- All pages in the prototype exist and match its layout on desktop, tablet and mobile.
