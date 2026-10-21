# Sway contracts: internal security review

Date: 2026-10-21. Branch `claude/new-session-rwx8b5`. Reviewer: the Sway build (Claude Code), at the owner's request.
**This is not a third-party audit.** It lowers the risk, it doesn't replace an independent review before the
contracts hold significant value.

## Scope

| Contract | Lines | Holds |
|---|---|---|
| `SwayKeys.sol` | 523 | Key markets, every trade's ETH, all earnings until claimed |
| `FanEscrow.sol` | 58 | Creator fees of unclaimed fan markets |
| `SwayStaking.sol` | 177 | Staked $SWAY, stakers' ETH rewards |
| `SwayLaunchpad.sol` | 276 | Creator tokens' bonding curves (ETH + tokens) |
| `GenesisPass.sol` | 115 | Soulbound passes (no funds) |
| `SwayDrops.sol` | 88 | Creator airdrops to holders (ETH) |
| `SwayCreatorToken.sol` | 18 | Fixed-supply ERC-20 |
| `script/Deploy.s.sol` | | Ownership and wiring at deploy |

Solidity 0.8.24, OpenZeppelin 5.4. Also reviewed: the server's wallet handling that decides where users' keys live.

## Method

1. Line-by-line manual review of every contract and the deploy script: access control, reentrancy and
   checks-effects-interactions, ETH and token accounting, rounding direction, overflow bounds, signature and
   merkle handling, admin and operator powers, pause behaviour.
2. Slither 0.11 (97 detectors) over `src/`.
3. Foundry: the existing suite (unit, fuzz, invariant, curve vectors replayed from the TypeScript quotes) plus
   a regression test for each fix, each shown to **fail on the old code** before the fix.
4. Mainnet deploy rehearsed on a local chain with mainnet's chain ID (4663).

## Findings

| ID | Severity | Where | Finding | Status |
|---|---|---|---|---|
| S-1 | Medium | SwayStaking | A stake placed just before the public `harvest()` took the protocol fees earned before it arrived. In the test, a late large stake took 99.9% of them. | **Fixed**: stake, unstake and claim harvest first. Test `test_lateStakerCannotTakeEarlierFees`. |
| S-2 | Medium | SwayStaking | Requesting an unstake dropped the fees earned while staked but not yet harvested. | **Fixed** by the same change. Test `test_unstakeKeepsFeesEarnedWhileStaked`. |
| L-1 | High (trust) | SwayLaunchpad | `migrate()` sends a graduated curve's ETH and tokens to any address the owner names; nothing onchain ties it to a pool. | **Mitigated**: the launchpad is not deployed on mainnet unless `DEPLOY_LAUNCHPAD=1`. Fix before enabling: migrate into a fixed DEX router/pool in the same call. |
| L-2 | Low | SwayLaunchpad | Airdrop claims weren't capped at the 10% allocation, so a wrong root could pay out tokens that belong to the curve. | **Fixed**: `airdropped[token]` capped at `HOLDER_ALLOCATION`. Test `test_airdropCappedAtHolderAllocation`. |
| D-1 | High (ops) | Deploy | Every contract's owner defaulted to the deployer, which is the server's hot operator key. | **Fixed**: mainnet refuses to deploy unless `ADMIN` is a different wallet (two-step transfer), or the owner opts into one key with `ALLOW_SINGLE_KEY=1` (`setup-chain.sh --mainnet`, answer SAME). One key is the owner's choice: a server break-in then controls settings and future fees, though not users' balances or sells. |
| D-2 | Medium (ops) | Deploy | On mainnet without $SWAY, staking would have been wired to a freshly minted test token. | **Fixed**: no staking (and never DevSway) on mainnet until `SWAY_TOKEN` is set; the stakers' half of the protocol fee goes to the treasury. |
| W-1 | High (ops) | Web wallet | The "Create a Sway wallet" option keeps the private key in the browser's storage: clearing the browser loses the funds, and any script injection could read it. | **Mitigated**: off on mainnet (API reports `embedded: 'off'`, the UI and the link routes refuse it). People use wallet apps there. A custodial-grade embedded wallet (Privy/CDP) can bring it back. |
| K-1 | Info (trust) | SwayKeys | The operator key can hand an unclaimed fan market and its escrow to any address, set referrers once per user, flag a creator inactive (their 6% then goes to holders) and open markets. | **Accepted**, by design (the server acts on X sign-ins). See operations below. |
| K-2 | Medium (trust) | SwayKeys | A compromised owner could point `staking` at a contract whose `levelOf` burns gas, reverts or returns a huge payload; `levelOf` runs on sells too, so holders could be stopped from selling. | **Fixed**: the staking read gets 50k gas, reads 32 bytes and treats anything odd as level 0. Tests in `HostileStaking.t.sol` (gas burner, return bomb, revert, out-of-range level). |
| G-1 | Low | GenesisPass | `_safeMint` calls the receiver; one contract that rejects it makes the whole `mintBatch` revert. | **Accepted**: the issuer retries without that address. |

### Slither (23 results, none exploitable)

- `incorrect-equality` (3): zero checks on sentinels (`firstTradeAt`, `supply`, harvested `amount`), not balances.
- `reentrancy-no-eth` in `claimFanMarket`: the only external call is FanEscrow (set once, ours) and the function is `nonReentrant`.
- `unused-return` (2), `missing-zero-check` (5, a zero signer/issuer intentionally disables launches/mints),
  `reentrancy-benign`/`-events`, `costly-loop`, `missing-inheritance`, `unindexed-event-address`: informational.

### Checked and sound

- **SwayKeys accounting**: every wei paid in is either the curve reserve, a credited earning or escrow; holder
  rewards use a per-unit accumulator that rounds down, so credits never exceed fees. Fees top out at 15% of the
  curve price (10% + 5% early-sell), so sell proceeds can't underflow. Buys refund change; sells take
  `minProceeds`. The creator's first key can't be sold; fan-market subjects have no private key.
- **Reentrancy**: `buy`, `sell`, `claim`, `claimFanMarket` and every ETH-sending function elsewhere are
  `nonReentrant` and update state before sending.
- **Overflow**: the curve reverts only beyond ~1.8e21 units, far past anything payable.
- **Pause**: blocks buys and market opening; sells and claims always work.
- **Ownership**: `Ownable2Step` everywhere; FanEscrow can only send funds back to SwayKeys.
- **Launchpad**: EIP-712 terms signed by the operator, one launch per creator, low-s signatures, rounding against
  the trader, sells capped at the real ETH reserve.
- **SwayDrops**: claims never exceed the deposit, the creator reclaims only after expiry, double-hashed leaves.
- **GenesisPass**: transfers, approvals and burns revert.

## Running mainnet safely

1. **Owner = your own wallet**, ideally a Safe multisig. `setup-chain.sh --mainnet` asks for it; then accept
   ownership on each contract from that wallet (explorer → Contract → Write → `acceptOwnership`). Answering SAME
   keeps one key for owner and operator on the server (no acceptOwnership step); move ownership to a separate
   wallet later with `transferOwnership` + `acceptOwnership` when you can.
2. **Operator key = hot, minimal.** It lives only in `/srv/sway/.env` (mode 600) and needs only gas money. If the
   server is ever compromised: from the owner wallet, `pause()` SwayKeys, `setOperator(old, false)` and
   `setFanAdmin(old, false)`, then set a new key.
3. **Emergency stop**: owner → `SwayKeys.pause()`. Buys stop; holders can still sell and claim.
4. **Treasury** defaults to the owner wallet.
5. **Watch** `FanMarketClaimed`, `ReferrerSet` and `CreatorInactiveSet` for anything the app didn't do.
6. **Still open**: the 5% early-sell fee is a build assumption (confirm it), launchpad migration (L-1) and staking
   wait for $SWAY, and a third-party audit is recommended before the contracts hold significant value.
