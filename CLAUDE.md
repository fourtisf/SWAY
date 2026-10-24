# Sway: notes for Claude Code

Read `docs/CLAUDE_CODE_BRIEF.md` (product), `docs/BUILD_NOTES.md` (decisions, deviations, open items) and, for
UI work, `docs/sway-prototype.html` (the approved reference: match its layout, copy and behaviour).

## Ground rules
- Money math lives in `packages/curve` and must match `contracts/src/SwayKeys.sol` to the wei. If you touch
  either, run `pnpm vectors` and `pnpm test:contracts` (CurveVectors replays the TS quotes on-chain).
- The scoring function in `packages/scoring/src/score.ts` is public (MIT) and shown on the Open model page.
  Never weight anything by hand.
- The API contract is `packages/shared/src/api.ts`. Change it there first; web and api both import it.
  Wei and units travel as decimal strings.
- Points are an append-only ledger (`PointsLedger`, unique `(userId, kind, ref)` for idempotency). Never
  update or delete ledger rows; write a compensating entry. Held-keys points are a live value
  (`User.heldPoints`, recounted every minute), not ledger rows.
- Onchain state (markets, holdings, trades, claims, stakes) is a mirror written only by the indexer in
  `apps/workers`. The API reads it and checks room access with an onchain `balanceOf` (cached ≤ 60s).
- Contracts are unaudited: keep the mainnet guards (API/workers `SWAY_ENABLE_MAINNET`, deploy `ALLOW_MAINNET`).
- Do not store X access tokens outside the Redis session.

## Commands
- `pnpm test`, `pnpm typecheck`, `pnpm build` (all workspaces); `pnpm test:contracts` (forge)
- `pnpm db:migrate` (new migration), `pnpm db:seed` (demo data), `bash scripts/deploy-local.sh` (anvil)
- `node scripts/export-abi.mjs` after changing a contract's external interface (writes packages/shared/src/abi)
- Workers integration tests start their own anvil (:8547, the wallet audit :8548, the sweep :8550, move-all :8551) and use the `sway_test_workers` database.

## Conventions
- TypeScript ESM everywhere; internal packages are consumed as TS source (no build step).
- Solidity 0.8.24, Foundry, OpenZeppelin 5.4 (submodule), custom errors, pull payments, `nonReentrant`.
- Keep comments sparse and about *why*; match the surrounding style.
