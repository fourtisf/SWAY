# Build notes

Decisions made while building from `CLAUDE_CODE_BRIEF.md`, where the brief left room or where the build
deviates from it, and what is still open. Keep this current.

## Contracts

| Topic | Decision |
|---|---|
| Curve rounding | `cost(a→b) = cumulative(b) − cumulative(a)` with `cumulative(u) = ⌊K·(u+200)³ / 3·10⁶⌋` (units). Flooring each cumulative value (not the difference) makes cost path-independent to the wei, so a market's reserve is always exactly `cumulative(supply) − cumulative(100)` and splitting trades can't drain the contract. |
| Fee rounding | Each fee is `⌊base·bps/10⁴⌋`; protocol is `⌊base·200·(10⁴−cut)/10⁸⌋`. Referral halves: trader gets `⌊ref/2⌋`, creator's referrer the rest; a missing half joins protocol, which then splits half stakers / half treasury. |
| First key | Minted free at market open (by the operator after X sign-in) and never sellable. It needs no reserve because it can never be sold. |
| Holder 1% | Reward-per-unit accumulator (1e18). Buys pay holders *before* the buy, sells pay holders *after* the sell, so the denominator is never below the locked key. The trader's own existing keys share pro rata. |
| Anti-snipe | Window starts at a market's first trade; post-trade balance ≤ 1,000 units (10 keys) per wallet for 5 minutes. |
| Keys | Not transferable (buy from / sell to the curve only). One market per X user id, enforced onchain (`subjectOfXId`). |
| Fan markets | Subject is `address(keccak256("sway.fan", xId))`. FanEscrow holds the first key and the 6% creator fee per market; `claimFanMarket` (operator, after X OAuth) moves both, plus the first key's holder rewards, to the owner. `setMarketHalted` blocks buys for takedowns; sells always work. |
| Pausing | `pause()` blocks buys and market opening. Sells and claims always work, so funds can't be trapped. |
| Pull payments | Every fee/reward is credited and pulled with `claim(subjects)` (one call: creator + holder + referral + protocol). Treasury and the staking contract pull the same way. Only trade proceeds, buy change and fan-market fees (to trusted FanEscrow) are sent directly. |
| Roles | `Ownable2Step` owner (multisig behind a timelock in production) sets operators, fan admins, treasury, staking; FanEscrow is set once. Fee parameters are constants (no admin path to change them). |
| Staking | Level thresholds 1K/10K/50K/250K $SWAY (placeholders). **Level names Beat / Rhythm / Tempo / Crescendo are placeholders**: only "Tempo" (−50%) appears in the prototype. Requesting an unstake drops the level immediately; 7-day cooldown. Stakers' ETH share is pulled by `harvest()`. |
| Genesis | ERC-721 + ERC-5192 locked; transfers, approvals and burns revert. `commitSnapshot(listHash)` once, then `mint`/`mintBatch` by the issuer; one pass per wallet. |
| Launchpad | Placeholder terms (brief Phase 3): 1B supply, 90% on a virtual constant-product curve whose start cap comes from an operator-signed EIP-712 attestation (prototype: $2,000 + score × 60), 10% merkle airdrop to key holders, 1% creator fee, curve closes at the graduation cap and the owner migrates liquidity (pool venue on Robinhood Chain to be decided). |
| EVM target | solc 0.8.24, `evm_version = cancun` (Robinhood Chain is Arbitrum Orbit). Verify the chain's ArbOS version before deploying. |
| Activity bond | Brief Phase 4. `SwayKeys.creatorInactive[subject]` (operator-set) moves the 6% creator fee into the holder fee; the trader pays the same total. The workers' `activity-bond` job sets it after 7 days without a room post by the creator and clears it on the next post (both onchain, mirrored as `KeyMarket.creatorInactive`). Unclaimed fan markets are exempt (nobody can post there yet; the contract refuses them). |
| Anti-dump fee | Brief Phase 4 says "higher sell fee within 24h of buying"; the size is ours: **+5% of the curve price**, paid to holders through the same accumulator. The window is per wallet and market, from `lastBuyAt[subject][holder]` (set on every buy). `quoteWei(…, { antiDump })` and the contract agree to the wei (curve vectors cover it). |
| Creator drops | `SwayDrops`: the creator funds `create(root, duration)` (1–365 days) with ETH, holders `claim(id, amount, proof)`, the creator `reclaim`s the rest after expiry. No attestation is needed because creators can only give their own ETH. The API builds the tree from key balances (pro rata to units, the creator's own wallets, the fan escrow and bot-flagged members left out) with the launchpad's leaf encoding; one funded drop per tree, because claims are tracked per (root, address). |

## Off-chain

| Topic | Decision |
|---|---|
| Score | The prototype's `scoreModel` (`Math.max(1, …)`) is the implementation; the Open model page shows the brief's simplified listing. ER averages the last 50 posts that aren't plain reposts; posts per week counts originals over the span those posts cover (min. one week). |
| Points | Score points + append-only ledger (tasks, invites, trade volume, battles) + live held points (recounted every minute, not ledger rows). Reorg corrections are new negative rows. Demo data uses a `seed` ledger kind. |
| Referrals | A referral is credited (points + onchain `setReferrer`) only when the invite is verified, so farm accounts never get the 0.5% trade share. |
| Tasks | "Hold a key you didn't mint" is automatic. Telegram can't be verified on X (skippable). When the X budget runs out, tasks ≤ 1,000 points are marked `trusted` and re-checked later (revoked with a reversing ledger row if X says no). |
| Battles | Points won for the weekly prize = payout − own stake; ties broken by wins. Without `X_BEARER_TOKEN` battles settle with a deterministic simulated read (dev only, logged). |
| Indexer | Polls confirmed blocks (`INDEXER_CONFIRMATIONS`, 0 on anvil, 2 elsewhere), one DB transaction per batch, bus events after commit. Reorgs: compare the cursor's block hash, walk back through `IndexedBlock`, delete mirrored rows above the ancestor, rebuild affected markets from their trades. Single active instance via a Redis lock. |
| `change` | Percent change over the last 24 trades (the prototype's definition), from the Trade mirror. |
| Mainnet guard | API and workers refuse chain 4663 unless `SWAY_ENABLE_MAINNET=1`; the deploy script needs `ALLOW_MAINNET=1` and a real `SWAY_TOKEN`. |
| Dev auth | `DEV_AUTH=1` (never in production) reproduces the prototype's demo sign-in with its `makeUser()` numbers; dev x ids are `9·10¹⁸ + hash(handle)` so they can't collide with real X ids. |
| Launchpad (API) | `POST /api/launchpad/attest` builds the 10% airdrop from the creator's Holding mirror (every holder with units > 0, the locked first key excluded; nobody else → the whole 10% to the account wallet) with `buildAirdrop`, stores `LaunchToken` terms + `LaunchAirdrop` leaves (replaced on re-attest until launch), and signs the EIP-712 `Launch` struct with `OPERATOR_PRIVATE_KEY` after checking it is `SwayLaunchpad.signer()`. Start cap `$2,000 + score × $60`, graduation `$69K`, both at the current ETH price; deadline 30 min. Only a member's own market (subject = account wallet) can launch: claimed fan markets can't, since `launch()` requires `msg.sender` to be the subject. Token views read the curve live (fallback: the indexer's mirror), and `tokenOf` covers the gap before the indexer sees `Launched`. Airdrop lists drop a leaf once `airdropClaimed` reads true; the API never writes `claimTx` (the indexer does). |
| Staking (API) | `GET /api/staking` reads SwayStaking and the $SWAY ERC-20 for the account wallet (cooldown compared with block time); the dev faucet also sends 10,000 $SWAY from the operator (the dev token's deployer) on local chains. |
| Several wallets | `Wallet` is the account wallet (owns the market subject, receives tips and the Genesis pass, fixed once the market is open); up to 10 more are linked by signature (`LinkedWallet`). An address belongs to one member across both tables. Holdings, room access, points and the wallet page count every wallet together. |
| Bot flags | Workers flag, never unflag: an account under 14 days old with fewer than 20 followers, or one with fewer than 10 followers that never posts and gets no engagement. X-verified, official and dev accounts are skipped. Admins review and clear flags in `/admin`. Flagged members keep points but lose rewards (Genesis, verified invites, creator drops). |
| Health | Workers serve `/healthz` (db, redis, rpc, indexer lag ≤ `maxLag`) and Prometheus `/metrics` (head, lag, per-job last success and failure counts) on `WORKERS_HEALTH_PORT`. Operator transactions from the API and the workers share one Redis lock (`lock:operator`) so nonces never clash. |
| Daily streak | One check-in per UTC day, `n × 100` points for day `n` of an unbroken streak, capped at 700 from day 7. Ledger kind `streak`, ref `streak:<day>`; a missed day restarts at 1. |
| Watchlist alerts | A watch stores a baseline price; the `price-alerts` job (every minute) sends one `trade` notification when the price moved `alertPct` (5–100%) from it and moves the baseline, so each move alerts once. |
| Web push | Payload-less pushes signed with VAPID (node:crypto, no dependency): the push service never sees notification text; the service worker fetches the newest unread notification. Endpoints must belong to a browser push service (FCM, Mozilla, Apple, WNS), so the workers can't be pointed at arbitrary URLs. One push per member per 10-second run; 404/410 subscriptions are dropped. Keys: `node scripts/vapid-keys.mjs`. |
| Notification prefs | Per type (trades, mentions, battles, points) plus price alerts and push. A muted type stays out of the list, the badge and push; rows are still written, so turning a type back on shows history. |
| Moderation | Reports (post or account, one open report per reporter and target) go to `/admin`: hide the post, dismiss, or flag the author as a bot (`botReason` "admin"; clearing a flag records `admin_cleared` so heuristics can skip it). Hidden posts vanish for everyone but admins and the author. Blocks are one-way for feeds (the blocker stops seeing the blocked account's posts and replies, their DM threads and their mentions) and two-way for DMs, follows and replies (403 `blocked`). Every admin write is logged with actor, action and target. Admins are granted from `ADMIN_HANDLES` at each sign-in and in `/admin`. |
| Account deletion | `DELETE /api/me` (typed "delete @handle"): posts soft-deleted with text and images cleared (others' replies keep their threads), DM threads, room messages, likes, reposts (counters corrected), follows, subscriptions, blocks, filed reports and claim requests, notifications to and from the account and uploads (rows and files) are deleted; every session is revoked through the per-user Redis set `usess:<userId>`. The User row becomes `deleted_<id>` / "Deleted account" with `joinedAt` and `memberNo` cleared, so member lists and workers skip it. Kept: onchain mirror rows, the points ledger, `Wallet`/`LinkedWallet` (the market's subject) and wallet activity. Signing in again with the same X id starts a fresh profile. |
| Images | `POST /api/uploads`: 1–4 files, ≤ 5 MB, type from magic bytes (jpeg/png/webp/gif; SVG and anything else refused), random 128-bit names in `UPLOAD_DIR`, `Upload` rows. Served with the stored type, `nosniff`, `default-src 'none'; sandbox` and a one-year immutable cache. Posts accept only the author's own uploads; locked posts never carry media URLs. |
| Boosts | $`BOOST_USD` (default 10) in ETH to `SwayKeys.treasury()` (or `TREASURY_ADDRESS`) from any of the member's wallets, checked onchain with the tips' 2% tolerance. Each tx boosts once (`Post.boostTx` plus a `boost:<tx>` activity ref); a running boost is extended by 24h. For You adds the prototype's +400 while `boostedUntil > now`; `boosted` stays for promoted posts. |

## Web

| Topic | Decision |
|---|---|
| Styling | The prototype's `<style>` block is ported verbatim into `globals.css` (Tailwind preflight off, tokens in `tailwind.config.ts`), so screens match the prototype pixel for pixel. One fix on top: on mobile the Markets table kept the hidden Followers column's grid track and squeezed names to ~40px; `.tr.mk` drops that track. |
| Modes | `NEXT_PUBLIC_API_MOCK=1` (`pnpm --filter @sway/web dev:mock`) swaps the API client for an in-memory adapter ported from the prototype's seed and simulation: design review and e2e need no backend. Real mode calls same-origin `/api/*` (rewritten to `API_URL`, which is baked in at build time) and the WebSocket at `NEXT_PUBLIC_WS_URL`. |
| Wallets | One `SwayWallet` interface. Burner (viem keys in localStorage, local/testnet; backup shows the key after a warning, import restores it) and wallet apps through wagmi connectors (EIP-6963 browser wallets, Coinbase Wallet SDK, WalletConnect only with a project id) are implemented; Privy and CDP adapters are stubs that throw until a provider is chosen. Sway draws its own connect modal; logos, names and download links come from RainbowKit's bundled wallet definitions (`@rainbow-me/rainbowkit/wallets`, metadata only). Buys send the quote + 1% (the contract refunds change); sells set `minProceeds` to 99% of the quote, which includes the anti-dump fee inside the 24h window. The Sway wallet sends contract calls with 25% gas over the estimate: trades that land first can make settling holder rewards cost more. |
| Several wallets | The account wallet (`Wallet`) owns the key market, gets tips and the Genesis pass, and is fixed once the market is open. Up to 10 more (`LinkedWallet`) are added by signature; an address belongs to one member across both tables (serializable transaction). Keys across all wallets count together (`memberAddresses()` in api/services/access.ts): room and holder-post access sums onchain balances, heldUnits, holders, Following, Messages, the auto task, points (workers) and the wallet page (sum plus per-wallet breakdown). The web keeps one active wallet per member and browser (localStorage); trades, tips and claims go through it, and claims run per wallet. |
| Gas drip | `GAS_DRIP_WEI` (default 0 = off): on a non-local chain, a member who signed in with real X (≥ 30 days old, ≥ 50 followers, no bot flag) gets it once from the operator when their account wallet is linked; idempotent through the Activity ref `gasdrip:<userId>`. |
| Indexer lag | After a receipt the UI shows the new holding immediately and polls the profile/wallet until the mirror catches up; trade events on the WebSocket refresh the same queries. |
| Build workaround | RainbowKit → wagmi connectors → `@base-org/account` → `@coinbase/cdp-sdk` imports optional `@x402/*` packages that aren't installed; `next.config.mjs` aliases them to empty modules. |
| Copy | Prototype wording kept, minus demo-only phrases ("Prototype", "…in the full build"). Additions: log out, claim/takedown request form, accept/decline on challenges, empty-room hint, API-unreachable banner. |
| Dark mode | Not in the prototype (Phase 4 settings). Light stays the default; Settings → Appearance offers Light / Dark / System. Implemented as `[data-theme="dark"]` overrides of the prototype's tokens plus the rules that hard-code white, set before first paint by an inline script. Canvas charts read the tokens and redraw on change. |
| Post menu & pages | "···" menu: own post Delete / Boost / Copy link, others Copy link / Report / Block, admins also Hide; @swaydotfamily (and admins) Pin to Home / Unpin on its top-level posts, one pinned at a time. Post page `/post/:id` shows the chain above, the post, a reply composer and two levels of replies. `/settings`, `/admin`, `/terms` and `/privacy` (templates, marked for counsel review) are linked from the nav, the rail footer, the drawer and the Connect X modal. |
| Share card | `/card/:handle` is public; its `opengraph-image` (next/og) draws the card, and the X intent carries the card URL so X unfurls it. Set `NEXT_PUBLIC_SITE_URL` (else `WEB_URL`) to the public origin for absolute OG URLs. Mock-mode admins: handles starting with "admin". |
| $SWAY card | Not in the prototype. The rail (desktop) and the drawer (mobile) show the $SWAY contract address with a copy button and a "Follow @swaydotfamily" link (also in the rail footer). The address is `NEXT_PUBLIC_SWAY_CA`, baked in at build time; empty shows "CA: Coming soon". |
| Fan markets by handle | The admin form needs only the X handle and category: the API reads the X user id, name, followers, avatar, checkmark and account age from X with the app bearer token (`users/by/username`) and scores the profile from them. Fields the admin fills in win; without a bearer token they are required. |

## Open items before mainnet

1. **Audit** of all contracts. An internal review is done (`docs/SECURITY_REVIEW.md`: two staking bugs and a launchpad
   cap fixed, deploy hardened); a third-party audit is still recommended before significant value. Mainnet runs
   through `deploy/setup-chain.sh --mainnet` (owner wallet separate from the operator key, no launchpad, no staking
   until $SWAY, browser wallets off, unaudited notice on trades).
2. **Verify Robinhood Chain parameters**: chain id (4663 per influence.family), explorer, ArbOS version / EVM target, RPC.
3. **Embedded wallets**: choose Privy or Coinbase CDP and wire the adapter (the web has the interface and a
   burner implementation for local/testnet).
4. **USDC withdrawals**: the swap/bridge path for "Withdraw in dollars → USDC" is not decided; the wallet
   currently withdraws ETH.
5. **$SWAY token**: supply, staking thresholds, level names, Genesis pool size (`GENESIS_POOL_UNITS`, defaults to
   5% of 1B).
6. **X API tier**: confirm the endpoints used (follows lookup, user timelines, tweet lookup) are in the plan, and
   set the per-15-minute limits in `packages/x` accordingly. Set `X_LAUNCH_POST_ID` for the repost task. On a plan
   without user timelines (X's free tier) sign-in still works: new members are scored from the public profile
   alone (followers, age, checkmark; no engagement or posting cadence) and a re-score job retries the read, so
   scores, task checks and battles need a plan that includes those reads to be accurate.
7. **Admin keys**: put the owner behind a multisig + timelock; move `OPERATOR_PRIVATE_KEY` / `ISSUER_PRIVATE_KEY`
   to a secrets manager; consider separating the operator (markets, referrers, fan claims) from the fan admin.
8. **Launchpad**: pool venue and migration flow.
9. **API contract polish**: `ownerAddress` on post authors (tip/subscribe fetch the profile today), cash
   balance on `MeDTO` (the mobile top bar fetches the wallet), a profile-exists flag for leaderboard rows.
10. **Anti-dump size**: the brief doesn't give one; 5% is a placeholder to confirm.
11. **Web push**: generate production VAPID keys (`VAPID_PUBLIC_KEY` on the API, both keys on the workers) and
    set `VAPID_SUBJECT` to a monitored contact.
12. **Live voice rooms** (brief Phase 4) are not built: they need a media server (an SFU such as LiveKit) and a
    hosting decision. Access would reuse the room check (`balanceOf` across the member's wallets).
13. **Fan-market creators can't launch a token**: `SwayLaunchpad.launch()` requires the sender to be the market's
    subject, and a claimed fan market's subject is the derived `fanSubject(xId)` address nobody holds a key for.
    The API answers `no_market`; fixing it needs a launchpad change (e.g. accept the market owner).
14. **Production env**: `ADMIN_HANDLES`, `UPLOAD_DIR` (on a backed-up volume; `deploy/backup.sh` archives it),
    `WEB_URL` or `NEXT_PUBLIC_SITE_URL` as the public origin (absolute OG card URLs), optional `TREASURY_ADDRESS`.
