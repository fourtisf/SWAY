/**
 * Seed data and generators ported line for line from docs/sway-prototype.html (mkCreator, mkFan,
 * CREATORS_SEED, FAN_SEED, POSTS, PINNED, LB, BATTLES, randTrade, makeUser). Same PRNG, same order of
 * draws, so mock screens show the prototype's numbers.
 */
import { CURVE, FEE_TOTAL, area, priceAt } from '@sway/curve';
import { score as scoreModel } from '@sway/scoring';
import { hash } from '@sway/shared';
import type { MarketCategory, Visibility } from '@sway/shared';

import { rng } from '../util';
export { rng };

export const ETH_USD = 3420;

/** A creator or fan market in prototype terms (supply in keys, money in ETH floats). */
export interface Creator {
  name: string;
  handle: string;
  followers: number;
  bio: string;
  verified: boolean;
  score: number;
  value: number;
  supply: number;
  holders: number;
  volume: number;
  hist: number[];
  change: number;
  claimed: boolean;
  joined: number;
  memberNo: number;
  cat: MarketCategory;
  escrow: number;
  isMe?: boolean;
  extraHolders?: Record<string, number>;
}

export const OFFICIAL = { name: 'Sway', handle: 'swaydotfamily', official: true, verified: true };

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

export function mkCreator(name: string, handle: string, followers: number, bio: string, verified: number | boolean, extra: Partial<Creator> = {}): Creator {
  const r = rng(hash(handle));
  const sm = scoreModel({ followers, er: 0.006 + r() * 0.045, ppw: 4 + r() * 22, age: 1 + r() * 11, verified: !!verified });
  const supply = +(1 + r() * 48 * Math.pow(Math.log10(followers) / 7, 2.2) + r() * 4).toFixed(2);
  const hist: number[] = [];
  let p = priceAt(Math.max(1, supply * (0.55 + r() * 0.35)));
  for (let i = 0; i < 40; i++) {
    p = p * (1 + (r() - 0.44) * 0.09);
    hist.push(p);
  }
  const now = priceAt(supply),
    sc = now / hist[hist.length - 1]!;
  for (let i = 0; i < hist.length; i++) hist[i]! *= sc;
  const holders = Math.max(1, Math.round(supply * (0.45 + r() * 0.5)));
  const volume = area(1, supply) * (1.4 + r() * 4.5);
  const change = (now / hist[hist.length - 25]! - 1) * 100;
  const joined = 2 + Math.floor(r() * 40);
  const memberNo = 100 + Math.floor(r() * 19000);
  return {
    name, handle, followers, bio, verified: !!verified, score: sm.score, value: sm.value, supply, holders, volume, hist, change,
    claimed: true, joined, memberNo, cat: 'creators', escrow: 0, ...extra,
  };
}

export function mkFan(cat: MarketCategory, name: string, handle: string, followers: number): Creator {
  const c = mkCreator(name, handle, followers, '', true, { claimed: false, cat });
  c.supply = +(1 + rng(hash(handle + 'f'))() * 9).toFixed(2);
  c.holders = Math.max(0, Math.round(c.supply * 0.6));
  const sc = priceAt(c.supply) / c.hist[c.hist.length - 1]!;
  c.hist = c.hist.map((v) => v * sc);
  c.volume = area(1, c.supply) * (2 + rng(hash(handle + 'v'))() * 6);
  c.escrow = (c.volume * CURVE.CREATOR) / (1 + FEE_TOTAL);
  c.bio = 'Fan market. This account has not joined Sway and does not run, endorse or profit from this market. The creator fee is held in escrow until the owner signs in with X.';
  return c;
}

export interface SeedPost {
  id: string;
  author: string;
  text: string;
  /** Minutes ago at seed time. */
  t: number;
  vis: Visibility;
  likes: number;
  rp: number;
  rep: number;
  boost: boolean;
  /** ms timestamp, set when the seed is built. */
  at: number;
  /* [B] */
  media?: string[];
  parentId?: string | null;
  hidden?: boolean;
  deleted?: boolean;
  /** ms timestamp of the end of a paid boost. */
  boostedUntil?: number;
}

export const PINNED_TEXT = `Shipped today on Sway:

Live trades on Home, every key buy and sell as it happens
Browse without signing in, connect X when you’re ready
Markets in one place: Creators, Crypto, Football, Stocks and RWA
A faster trade sheet for keys, priced in dollars
Wallet in dollars, with every earning in one card to claim
Launchpad: turn your reach into a token with one switch

The scoring model is public. Read it on swayfamily.com/model`;

export const POSTS_SEED: Array<[string, string, number, Visibility, number, number, number, boolean]> = [
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
];

const SYL = ['ka', 'zu', 'mi', 'ro', 'ven', 'tal', 'sha', 'lo', 'qi', 'dar', 'nex', 'po', 'ri', 'sol', 'fen', 'yu', 'ark', 'bel', 'cy', 'dro'];

export interface LbRow {
  handle: string;
  name: string;
  pts: number;
  won: number;
  fees: number;
  staked: number;
}

export function buildLB(pool: Creator[]): LbRow[] {
  const r = rng(777);
  const out: LbRow[] = [];
  for (let i = 0; i < 60; i++) {
    let h: string, n: string;
    if (i % 5 === 2) {
      const c = pool[(i * 3) % pool.length]!;
      h = c.handle;
      n = c.name;
    } else {
      h = SYL[Math.floor(r() * 20)]! + SYL[Math.floor(r() * 20)]!;
      h += r() > 0.5 ? Math.floor(r() * 99) : '';
      h += r() > 0.6 ? '.eth' : '';
      n = h.replace('.eth', '');
      n = n[0]!.toUpperCase() + n.slice(1);
    }
    const pts = Math.round(3400000 * Math.pow(i + 1, -0.62) * (0.92 + r() * 0.16));
    const won = Math.round(r() * 42000);
    const fees = r() * 0.9;
    out.push({ handle: h, name: n, pts, won, fees, staked: Math.round(900000 * Math.pow(i + 1, -0.8)) });
  }
  const seen = new Set<string>();
  return out.filter((x) => !seen.has(x.handle) && !!seen.add(x.handle)).sort((a, b) => b.pts - a.pts);
}

export interface SeedBattle {
  id: string;
  a: string;
  b: string | null;
  theme: string;
  tag: string;
  stake: number;
  ends: number;
  erA: number;
  erB: number;
  poolA: number;
  poolB: number;
}

export const battlesSeed = (now: number): SeedBattle[] => [
  { id: '1', a: 'makotrades', b: 'vexcapital', theme: 'One chart that explains this cycle', tag: '#SwayBattle', stake: 12000, ends: now + 36e5 * 14.2, erA: 0.031, erB: 0.026, poolA: 48200, poolB: 31700 },
  { id: '2', a: 'kenjionchain', b: 'irischain', theme: 'The most underrated chain of 2026', tag: '#SwayBattle', stake: 5000, ends: now + 36e5 * 6.7, erA: 0.019, erB: 0.024, poolA: 12900, poolB: 20400 },
  { id: '3', a: 'junopark', b: 'dunabuilds', theme: 'Explain keys to your mom in one post', tag: '#SwayBattle', stake: 0, ends: now + 36e5 * 20.1, erA: 0.044, erB: 0.051, poolA: 2300, poolB: 3900 },
];

export interface SeedTrade {
  id: string;
  buyer: string;
  c: string;
  buy: boolean;
  k: number;
  /** Curve price (base) in ETH. */
  eth: number;
  t: number;
  supplyAfter: number;
}

let TID = 0;
export function randTrade(cs: Creator[], lb: LbRow[], r: () => number, at: number): SeedTrade {
  const c = cs[Math.floor(r() * cs.length)]!,
    b = lb[Math.floor(r() * lb.length)]!;
  const k = +(r() < 0.55 ? 1 : 0.1 + r() * 2.4).toFixed(2),
    buy = r() > 0.28;
  const eth = buy ? area(c.supply, c.supply + k) : area(Math.max(1, c.supply - k), c.supply);
  return { id: `t${++TID}`, buyer: b.handle, c: c.handle, buy, k, eth, t: at, supplyAfter: buy ? c.supply + k : Math.max(1, c.supply - k) };
}

export interface MockUser {
  handle: string;
  name: string;
  followers: number;
  verified: boolean;
  score: number;
  value: number;
  wallet: `0x${string}`;
  memberNo: number;
}

export function makeUser(handleIn: string, followersIn?: number): MockUser {
  const handle = handleIn.replace(/^@/, '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '') || 'you';
  const r = rng(hash(handle + 'u'));
  const followers = followersIn || Math.round(Math.pow(10, 2.6 + r() * 3.2));
  const inputs = { followers, er: 0.008 + r() * 0.04, ppw: 3 + r() * 18, age: 1 + r() * 9, verified: r() > 0.35 };
  const sm = scoreModel(inputs);
  const wallet = ('0x' + [...Array(40)].map((_, i) => '0123456789abcdef'[hash(handle + i) % 16]).join('')) as `0x${string}`;
  return { handle, name: handle[0]!.toUpperCase() + handle.slice(1), followers, verified: inputs.verified, score: sm.score, value: sm.value, wallet, memberNo: 19800 + Math.floor(r() * 900) };
}

/** Deterministic fake address for a handle (subjects, owners). */
export const fakeAddress = (seed: string): `0x${string}` =>
  ('0x' + [...Array(40)].map((_, i) => '0123456789abcdef'[hash(seed + ':' + i) % 16]).join('')) as `0x${string}`;

export const fakeHash = (seed: string): `0x${string}` =>
  ('0x' + [...Array(64)].map((_, i) => '0123456789abcdef'[hash(seed + '#' + i) % 16]).join('')) as `0x${string}`;
