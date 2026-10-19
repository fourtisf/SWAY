/**
 * Local demo data: the prototype's seed generators (sway-prototype.html) ported with the same hash/rng,
 * so a seeded local stack shows the prototype's creators, fan markets, posts, leaderboard and battles.
 * Used by prisma/seed.ts (database) and apps/workers seed-chain (opens markets and trades on anvil).
 * Never run against production.
 */
import { score as scoreModel } from '@sway/scoring';
import { hash } from '@sway/shared';
import type { MarketCategory } from '@sway/shared';

export function rng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic uint64 X id for demo and dev-login accounts (same formula as the API's dev auth). */
export const demoXId = (handle: string): string => (9_000_000_000_000_000_000n + BigInt(hash(handle))).toString();

const priceAt = (s: number) => 0.0000175 * Math.pow(s + 2, 2);
const area = (a: number, b: number) => (0.0000175 / 3) * (Math.pow(b + 2, 3) - Math.pow(a + 2, 3));

export interface DemoCreator {
  name: string;
  handle: string;
  xId: string;
  followers: number;
  bio: string;
  verified: boolean;
  inputs: { followers: number; er: number; ppw: number; age: number; verified: boolean };
  score: number;
  value: number;
  /** Target supply in keys (the prototype's c.supply). */
  supply: number;
  holders: number;
  joinedDaysAgo: number;
  memberNo: number;
  fan: boolean;
  category: MarketCategory;
}

export const OFFICIAL = { name: 'Sway', handle: 'swaydotfamily', bio: 'The official Sway account.' };

export const CREATORS_SEED: Array<[string, string, number, string, number]> = [
  ['Nova Reyes', 'novareyes', 412000, 'Onchain sleuth. I trace the wallets so you don’t have to. Holders get the addresses first.', 1],
  ['Atlas Research', 'atlas_rsch', 621000, 'Independent research desk. Long-form, cited, no shills.', 1],
  ['Mako', 'makotrades', 254000, 'Perps, memes, and the occasional humbling. Battle record 14–3.', 1],
  ['Kenji Arata', 'kenjionchain', 186000, 'Buying small builders early. Robinhood Chain maxi.', 1],
  ['Bram Okafor', 'bramokafor', 305000, 'Position sizing over picking. Frameworks in my room.', 1],
  ['Iris Chain', 'irischain', 212000, 'Markets, culture, and the people moving both.', 1],
  ['Vex Capital', 'vexcapital', 149000, 'Macro notes weekly for subscribers. Hedged into everything.', 1],
  ['Rafi Kova', 'rafikova', 132000, 'Growth for crypto founders. Replies are the whole game.', 1],
  ['Ledger Lena', 'ledgerlena', 97000, 'Security reminders nobody asked for. You’re welcome.', 1],
  ['Selene', 'selenedefi', 88000, 'DeFi yields, explained without the cope.', 0],
  ['Priya Sol', 'priyasol', 73000, 'Building dashboards on the Sway indexer. Open-source everything.', 1],
  ['Mira Lune', 'miralune', 66000, 'Art, memes, and tipping small accounts.', 0],
  ['Juno Park', 'junopark', 57000, 'Daily streaker. 31 days and counting.', 0],
  ['0xHalcyon', '0xhalcyon', 41000, 'Grinding the Genesis board. Ask me about 1/√r.', 0],
  ['Duna', 'dunabuilds', 28000, 'Shipping a wallet in public. Week 9.', 0],
  ['Tomas Weld', 'tomasweld', 19000, 'Explainers for people who skip the docs.', 0],
];

export const FAN_SEED: Record<Exclude<MarketCategory, 'creators'>, Array<[string, string, number]>> = {
  crypto: [['Orbit Labs', 'orbitlabs', 1200000], ['Halo Exchange', 'haloexchange', 2400000], ['Cinder Network', 'cindernet', 920000], ['Kestrel Wallet', 'kestrelwallet', 640000], ['Quanta DAO', 'quantadao', 310000], ['Driftwood Finance', 'driftwoodfi', 180000]],
  football: [['Real Calder', 'realcalder', 12100000], ['FC Meridian', 'fcmeridian', 8400000], ['Teo Varga', 'teovarga10', 5600000], ['Luca Brennan', 'lucabrennan9', 3100000], ['Sporting Aurel', 'sportingaurel', 2200000]],
  stocks: [['Northwind Motors', 'northwindmtr', 4800000], ['Apex Silicon', 'apexsilicon', 2900000], ['Corvid Bank', 'corvidbank', 1100000], ['Lumen Air', 'lumenair', 760000]],
  rwa: [['Solace Treasury', 'solacetsy', 410000], ['Helix Gold Vault', 'helixvault', 220000], ['Terra Estates', 'terraestates', 140000], ['Brightwater Credit', 'brightwatercr', 95000]],
};

export const FAN_BIO =
  'Fan market. This account has not joined Sway and does not run, endorse or profit from this market. The creator fee is held in escrow until the owner signs in with X.';

function mkCreator(name: string, handle: string, followers: number, bio: string, verified: number): DemoCreator {
  const r = rng(hash(handle));
  const inputs = { followers, er: 0.006 + r() * 0.045, ppw: 4 + r() * 22, age: 1 + r() * 11, verified: !!verified };
  const sm = scoreModel(inputs);
  const supply = +(1 + r() * 48 * Math.pow(Math.log10(followers) / 7, 2.2) + r() * 4).toFixed(2);
  r(); // starting price of the prototype's history walk
  for (let i = 0; i < 40; i++) r();
  const holders = Math.max(1, Math.round(supply * (0.45 + r() * 0.5)));
  r(); // volume multiplier
  const joinedDaysAgo = 2 + Math.floor(r() * 40);
  const memberNo = 100 + Math.floor(r() * 19000);
  return {
    name, handle, xId: demoXId(handle), followers, bio, verified: !!verified, inputs,
    score: sm.score, value: sm.value, supply, holders, joinedDaysAgo, memberNo, fan: false, category: 'creators',
  };
}

function mkFan(category: Exclude<MarketCategory, 'creators'>, name: string, handle: string, followers: number): DemoCreator {
  const c = mkCreator(name, handle, followers, FAN_BIO, 1);
  const supply = +(1 + rng(hash(handle + 'f'))() * 9).toFixed(2);
  return { ...c, supply, holders: Math.max(0, Math.round(supply * 0.6)), fan: true, category, memberNo: 0, joinedDaysAgo: 0 };
}

export const demoCreators = (): DemoCreator[] => CREATORS_SEED.map((a) => mkCreator(...a));

export const demoFans = (): DemoCreator[] =>
  (Object.entries(FAN_SEED) as Array<[Exclude<MarketCategory, 'creators'>, Array<[string, string, number]>]>).flatMap(([cat, arr]) =>
    arr.map(([n, h, f]) => mkFan(cat, n, h, f)),
  );

/** The prototype's makeUser(): profile + score inputs for a dev/demo handle. */
export function makeUser(handleIn: string, followersIn?: number) {
  const handle = handleIn.replace(/^@/, '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '') || 'you';
  const r = rng(hash(handle + 'u'));
  const followers = followersIn || Math.round(Math.pow(10, 2.6 + r() * 3.2));
  const inputs = { followers, er: 0.008 + r() * 0.04, ppw: 3 + r() * 18, age: 1 + r() * 9, verified: r() > 0.35 };
  const sm = scoreModel(inputs);
  return { handle, name: handle[0]!.toUpperCase() + handle.slice(1), followers, inputs, verified: inputs.verified, score: sm.score, value: sm.value, memberNo: 19800 + Math.floor(r() * 900) };
}

const SYL = ['ka', 'zu', 'mi', 'ro', 'ven', 'tal', 'sha', 'lo', 'qi', 'dar', 'nex', 'po', 'ri', 'sol', 'fen', 'yu', 'ark', 'bel', 'cy', 'dro'];

export interface DemoLeader {
  handle: string;
  name: string;
  pts: number;
  won: number;
  staked: number;
  /** True when this row is one of the demo creators. */
  creator: boolean;
}

/** The prototype's LB: 60 rows, every fifth one a creator, deduplicated and sorted by points. */
export function demoLeaderboard(): DemoLeader[] {
  const r = rng(777);
  const pool = demoCreators();
  const out: DemoLeader[] = [];
  for (let i = 0; i < 60; i++) {
    let h: string;
    let n: string;
    let creator = false;
    if (i % 5 === 2) {
      const c = pool[(i * 3) % pool.length]!;
      h = c.handle;
      n = c.name;
      creator = true;
    } else {
      h = SYL[Math.floor(r() * 20)]! + SYL[Math.floor(r() * 20)]! + (r() > 0.5 ? Math.floor(r() * 99) : '') + (r() > 0.6 ? '.eth' : '');
      n = h.replace('.eth', '');
      n = n[0]!.toUpperCase() + n.slice(1);
    }
    const pts = Math.round(3400000 * Math.pow(i + 1, -0.62) * (0.92 + r() * 0.16));
    const won = Math.round(r() * 42000);
    r(); // fees
    const staked = Math.round(900000 * Math.pow(i + 1, -0.8));
    out.push({ handle: h.replace(/[^a-z0-9_]/gi, '').toLowerCase(), name: n, pts, won, staked, creator });
  }
  const seen = new Set<string>();
  return out.filter((x) => !seen.has(x.handle) && seen.add(x.handle)).sort((a, b) => b.pts - a.pts);
}

export const PINNED_TEXT = `Shipped today on Sway:

Live trades on Home, every key buy and sell as it happens
Browse without signing in, connect X when you’re ready
Markets in one place: Creators, Crypto, Football, Stocks and RWA
A faster trade sheet for keys, priced in dollars
Wallet in dollars, with every earning in one card to claim
Launchpad: turn your reach into a token with one switch

The scoring model is public. Read it on swayfamily.com/model`;

export interface DemoPost {
  author: string;
  text: string;
  minutesAgo: number;
  visibility: 'public' | 'holders' | 'subs';
  likes: number;
  reposts: number;
  replies: number;
  boosted: boolean;
  pinned?: boolean;
}

export const demoPosts = (): DemoPost[] => [
  { author: OFFICIAL.handle, text: PINNED_TEXT, minutesAgo: 19 * 60, visibility: 'public', likes: 2840, reposts: 611, replies: 402, boosted: false, pinned: true },
  ...(
    [
      ['novareyes', 'Holders room tonight: the 3 wallets that front-ran every Robinhood Chain listing this month. Charts and addresses inside.', 38, 'holders', 412, 61, 88, true],
      ['atlas_rsch', 'Open model update: replies now weigh 3x likes, and reach stays on a log curve so 50M followers can’t buy the board.\n\nThe formula is public. Fork it, break it, send a PR. #OpenModel', 55, 'public', 1840, 402, 233, false],
      ['makotrades', 'Battle accepted vs @vexcapital. Theme: one chart that explains this cycle. 24h window.\n\nBack me if you think 254K can out-engage 149K #SwayBattle', 12, 'public', 933, 140, 301, false],
      ['kenjionchain', 'Bought my first 2 keys of @dunabuilds at supply 4. Small builders with real replies are where the curve is cheapest.', 95, 'public', 266, 31, 40, false],
      ['ledgerlena', 'Daily reminder: keys are access, not equity. Buy rooms you would actually sit in.', 140, 'public', 1205, 288, 74, false],
      ['bramokafor', 'Draft for holders: how I size memecoin entries by liquidity depth instead of market cap. Worksheet attached.', 210, 'holders', 540, 77, 92, false],
      ['selenedefi', 'Staked up to Tempo. Protocol fee on my trades dropped 50% and posts can run 2,000 characters now. Worth it if you trade daily.', 260, 'public', 178, 22, 35, false],
      ['irischain', 'Fan market for @orbitlabs passed $1,400 in volume and they haven’t even joined. Fees sit in escrow until they claim. #FanMarkets', 320, 'public', 689, 120, 97, false],
      ['junopark', 'gm. 31 day streak on daily tasks. Echo tier unlocked. #SwayDaily', 400, 'public', 301, 18, 64, false],
      ['vexcapital', 'Weekly macro note is up for subscribers. Rates, ETH/BTC, and why I’m hedged into the snapshot.', 460, 'subs', 210, 12, 19, false],
      ['0xhalcyon', 'Genesis snapshot soon. Weighting is 1/√rank, so #50 still gets about 14% of what #1 gets. Grinding. #Genesis', 530, 'public', 455, 70, 58, false],
      ['priyasol', 'Built a small dashboard that reads key trades straight from the indexer. Open-sourcing it this weekend.', 610, 'public', 390, 66, 47, false],
      ['rafikova', 'If your score is low it’s usually reply rate. People talk at their followers, not with them.', 720, 'public', 1502, 377, 129, false],
      ['miralune', 'Tipped @tomasweld $20 for the clearest explainer of the curve I’ve read. Small accounts doing the real work.', 860, 'public', 244, 29, 21, false],
    ] as Array<[string, string, number, DemoPost['visibility'], number, number, number, boolean]>
  ).map(([author, text, minutesAgo, visibility, likes, reposts, replies, boosted]) => ({ author, text, minutesAgo, visibility, likes, reposts, replies, boosted })),
];

export interface DemoBattle {
  a: string;
  b: string;
  theme: string;
  stake: number;
  endsInHours: number;
  erA: number;
  erB: number;
  poolA: number;
  poolB: number;
}

export const demoBattles = (): DemoBattle[] => [
  { a: 'makotrades', b: 'vexcapital', theme: 'One chart that explains this cycle', stake: 12000, endsInHours: 14.2, erA: 0.031, erB: 0.026, poolA: 48200, poolB: 31700 },
  { a: 'kenjionchain', b: 'irischain', theme: 'The most underrated chain of 2026', stake: 5000, endsInHours: 6.7, erA: 0.019, erB: 0.024, poolA: 12900, poolB: 20400 },
  { a: 'junopark', b: 'dunabuilds', theme: 'Explain keys to your mom in one post', stake: 0, endsInHours: 20.1, erA: 0.044, erB: 0.051, poolA: 2300, poolB: 3900 },
];

/** Demo prices (for scripts that need a number without the price feed). */
export const demoPriceAt = priceAt;
export const demoArea = area;
