/** [C] Launchpad (terms, attestation, tokens, key-holder airdrops) and $SWAY staking. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  POST_MAX_STAKED,
  STAKING_COOLDOWN_S,
  STAKING_DEFAULT_THRESHOLDS,
  STAKING_LEVELS,
  launchStartCapUsd,
  type Address,
  type AirdropAllocationDTO,
  type AirdropsResponse,
  type LaunchAttestation,
  type LaunchTokenResponse,
  type LaunchpadResponse,
  type StakingResponse,
} from '@sway/shared';
import { HandleParams, body, params, userByHandle } from './_util';
import { getViewer, requireViewer } from '../plugins/auth';
import { userRef } from '../services/dto';
import { permitsEnabled } from '../services/onboarding';
import {
  attest,
  launchChainOf,
  launchableMarket,
  suggestedSymbol,
  termsDTO,
  tokenAddressOf,
  tokenDTO,
  viewerWallets,
} from '../services/launch';
import type { OnchainStaking } from '../services/launch-chain';

export async function launchRoutes(app: FastifyInstance) {
  const { prisma } = app.deps;
  const lc = () => launchChainOf(app);

  app.get('/launchpad', async (req): Promise<LaunchpadResponse> => {
    const v = await getViewer(req);
    if (!v) return { symbol: '$YOU', score: null, startCapUsd: null, launched: false, tokenAddress: null };
    const lt = await prisma.launchToken.findUnique({ where: { userId: v.user.id } });
    const token = await tokenAddressOf(lc(), lt, v.wallet?.address ?? null);
    const base: LaunchpadResponse = {
      symbol: '$' + (lt?.symbol ?? suggestedSymbol(v.user)),
      score: v.user.score,
      startCapUsd: launchStartCapUsd(v.user.score),
      launched: !!token,
      tokenAddress: token,
    };
    if (token && v.wallet) {
      const wallets = await viewerWallets(prisma, v);
      base.token = await tokenDTO(
        app.deps,
        lc(),
        { user: { ...v.user, market: v.market }, wallet: v.wallet.address },
        lt,
        token,
        { userId: v.user.id, wallets },
      );
      return base;
    }
    const market = launchableMarket(v, permitsEnabled(app.deps));
    if (market) base.terms = await termsDTO(app.deps, v, market);
    return base;
  });

  app.get('/launchpad/tokens/:handle', async (req): Promise<LaunchTokenResponse> => {
    const { handle } = params(HandleParams, req);
    const u = await userByHandle(req, handle, { market: true, wallet: true, launchToken: true });
    const lt = u.launchToken;
    const owner = u.wallet?.address ?? null;
    const token = await tokenAddressOf(lc(), lt, owner);
    const v = await getViewer(req);
    const out: LaunchTokenResponse = {
      creator: { ...userRef(u, u.market), score: u.score },
      symbol: '$' + (lt?.symbol ?? suggestedSymbol(u)),
      launched: !!token,
      token: null,
    };
    if (token && owner) {
      const viewer = v ? { userId: v.user.id, wallets: await viewerWallets(prisma, v) } : null;
      out.token = await tokenDTO(app.deps, lc(), { user: u, wallet: owner }, lt, token, viewer);
    }
    return out;
  });

  app.post(
    '/launchpad/attest',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req): Promise<LaunchAttestation> => {
      const v = await requireViewer(req);
      const b = body(z.object({ name: z.string().max(200).optional(), symbol: z.string().max(40).optional() }), req);
      return attest(app.deps, lc(), v, b);
    },
  );

  app.get('/launchpad/airdrops', async (req): Promise<AirdropsResponse> => {
    const v = await getViewer(req);
    const chain = lc();
    const launchpad = chain.launchpad;
    if (!v) return { launchpad, allocations: [] };
    const wallets = await viewerWallets(prisma, v);
    if (!wallets.length) return { launchpad, allocations: [] };
    const rows = await prisma.launchAirdrop.findMany({
      where: { address: { in: wallets }, claimTx: null },
      include: { launchToken: { include: { user: { include: { market: true, wallet: true } } } } },
    });
    const out: AirdropAllocationDTO[] = [];
    for (const r of rows) {
      const lt = r.launchToken;
      const token = await tokenAddressOf(chain, lt, lt.user.wallet?.address ?? null);
      if (!token) continue; // attested but not launched yet
      if (chain.launchEnabled) {
        // Hide what is already claimed onchain (before the indexer mirrors it) and leaves of a stale attestation.
        const [claimed, curve] = await Promise.all([
          chain.airdropClaimed(token, r.address as Address).catch(() => false),
          chain.curve(token).catch(() => null),
        ]);
        if (claimed) continue;
        if (curve && lt.airdropRoot && curve.airdropRoot.toLowerCase() !== lt.airdropRoot.toLowerCase()) {
          req.log.warn(
            { token, handle: lt.user.handle },
            'stored airdrop root differs from the onchain root',
          );
          continue;
        }
      }
      out.push({
        token,
        name: lt.name,
        symbol: lt.symbol,
        creator: userRef(lt.user, lt.user.market),
        address: r.address as Address,
        walletKind: r.address === v.wallet?.address.toLowerCase() ? 'account' : 'linked',
        amount: r.amount.toFixed(0),
        proof: r.proof as `0x${string}`[],
      });
    }
    return { launchpad, allocations: out };
  });

  app.get('/staking', async (req): Promise<StakingResponse> => {
    const v = await getViewer(req);
    const chain = lc();
    const address = (v?.wallet?.address.toLowerCase() as Address | undefined) ?? null;
    let s: OnchainStaking | null = null;
    if (chain.stakingEnabled) {
      try {
        s = await chain.stakingState(address);
      } catch (e) {
        req.log.warn({ err: e }, 'staking read failed');
      }
    }
    const thresholds = s?.thresholds ?? [...STAKING_DEFAULT_THRESHOLDS];
    // The contract compares unlockAt with block time.
    const nowS = s?.blockTime || Math.floor(Date.now() / 1000);
    return {
      enabled: !!s,
      stakingAddress: chain.staking,
      tokenAddress: s?.token ?? null,
      tokenSymbol: 'SWAY',
      address,
      balanceWei: (s?.balance ?? 0n).toString(),
      allowanceWei: (s?.allowance ?? 0n).toString(),
      stakedWei: (s?.staked ?? 0n).toString(),
      unstakingWei: (s?.unstaking ?? 0n).toString(),
      unlockAt: s && s.unstaking > 0n ? new Date(s.unlockAt * 1000).toISOString() : null,
      canWithdraw: !!s && s.unstaking > 0n && s.unlockAt <= nowS,
      level: s?.level ?? 0,
      levels: STAKING_LEVELS.slice(1).map((l, i) => ({
        level: l.level,
        name: l.name,
        cut: l.cut,
        thresholdWei: (thresholds[i] ?? 0n).toString(),
        postMax: POST_MAX_STAKED,
      })),
      pendingRewardsWei: (s?.pendingRewards ?? 0n).toString(),
      totalStakedWei: (s?.totalStaked ?? 0n).toString(),
      cooldownSeconds: STAKING_COOLDOWN_S,
    };
  });
}
