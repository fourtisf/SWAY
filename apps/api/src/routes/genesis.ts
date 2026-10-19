/**
 * [C] The frozen Genesis list (brief §8): GenesisPass.commitSnapshot points at `${WEB_URL}/genesis/list/<id>`,
 * which reads GET /api/genesis/snapshots/:id. Shares are the integer allocation stored at the snapshot.
 */
import type { FastifyInstance } from 'fastify';
import type { GenesisEntry, GenesisSnapshot, KeyMarket, User } from '@sway/db';
import { shortAddress, type Address, type GenesisListResponse } from '@sway/shared';
import { IdParams, params } from './_util';
import { getViewer } from '../plugins/auth';
import { notFound } from '../errors';
import { userRef } from '../services/dto';

/** Percent of the pool an entry's units are (exact to 1e-8 %). */
export function snapshotSharePct(
  units: { toFixed(d: number): string },
  poolUnits: { toFixed(d: number): string },
): number {
  const pool = BigInt(poolUnits.toFixed(0));
  if (pool === 0n) return 0;
  return Number((BigInt(units.toFixed(0)) * 10n ** 10n) / pool) / 1e8;
}

type Entry = GenesisEntry & { user: User & { market: KeyMarket | null } };

function listDTO(snap: GenesisSnapshot, entries: Entry[], meId: string | null): GenesisListResponse {
  return {
    snapshotId: snap.id,
    takenAt: snap.takenAt.toISOString(),
    listHash: snap.listHash,
    poolUnits: snap.poolUnits.toFixed(0),
    published: snap.published,
    count: entries.length,
    minted: entries.filter((e) => !!e.mintTx).length,
    rows: entries.map((e) => ({
      rank: e.rank,
      user: userRef(e.user, e.user.market),
      wallet: e.wallet as Address,
      walletShort: shortAddress(e.wallet),
      points: e.points,
      sharePct: snapshotSharePct(e.units, snap.poolUnits),
      units: e.units.toFixed(0),
      minted: !!e.mintTx,
      mintTx: e.mintTx,
      me: e.userId === meId,
    })),
  };
}

export async function genesisRoutes(app: FastifyInstance) {
  const { prisma } = app.deps;
  const entries = (snapshotId: string) =>
    prisma.genesisEntry.findMany({
      where: { snapshotId },
      orderBy: { rank: 'asc' },
      include: { user: { include: { market: true } } },
    });

  app.get('/genesis/snapshots/latest', async (req): Promise<GenesisListResponse> => {
    const snap = await prisma.genesisSnapshot.findFirst({
      where: { takenAt: { lte: new Date() } },
      orderBy: { takenAt: 'desc' },
    });
    if (!snap) throw notFound('No Genesis snapshot has been taken yet', 'no_snapshot');
    const v = await getViewer(req);
    return listDTO(snap, await entries(snap.id), v?.user.id ?? null);
  });

  app.get('/genesis/snapshots/:id', async (req): Promise<GenesisListResponse> => {
    const { id } = params(IdParams, req);
    const snap = await prisma.genesisSnapshot.findUnique({ where: { id } });
    if (!snap) throw notFound('No Genesis snapshot with that id', 'snapshot_not_found');
    const v = await getViewer(req);
    return listDTO(snap, await entries(snap.id), v?.user.id ?? null);
  });
}
