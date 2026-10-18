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

## Open items before mainnet

1. **Audit** of all contracts; publish the report, then lift the mainnet flags.
2. **Verify Robinhood Chain parameters**: chain id (4663 per influence.family), explorer, ArbOS version / EVM target, RPC.
3. **Embedded wallets**: choose Privy or Coinbase CDP and wire the adapter (the web has the interface and a
   burner implementation for local/testnet).
4. **USDC withdrawals**: the swap/bridge path for "Withdraw in dollars → USDC" is not decided; the wallet
   currently withdraws ETH.
5. **$SWAY token**: supply, staking thresholds, level names, Genesis pool size (`GENESIS_POOL_UNITS`, defaults to
   5% of 1B).
6. **X API tier**: confirm the endpoints used (follows lookup, user timelines, tweet lookup) are in the plan, and
   set the per-15-minute limits in `packages/x` accordingly. Set `X_LAUNCH_POST_ID` for the repost task.
7. **Admin keys**: put the owner behind a multisig + timelock; move `OPERATOR_PRIVATE_KEY` / `ISSUER_PRIVATE_KEY`
   to a secrets manager; consider separating the operator (markets, referrers, fan claims) from the fan admin.
8. **Launchpad**: pool venue and migration flow, airdrop root generation from the key-holder snapshot.
9. **Phase 4** (brief §11): post detail page with threads, price chart ranges, PnL (cost basis is already
   mirrored per holding), OG card image, settings, creator activity bond, anti-dump fee, voice rooms.
