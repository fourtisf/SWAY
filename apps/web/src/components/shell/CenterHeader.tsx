'use client';
import { unitsToKeys, weiToEth } from '@sway/curve';
import type { FeedTab, TradeDTO } from '@sway/shared';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useActions } from '@/lib/actions';
import { useFormat } from '@/lib/format';
import { useGoBack } from '@/lib/nav';
import { useDm, useMe, useProfile, useTrades, useWallet } from '@/lib/queries';
import { openModal, toast, useUI } from '@/lib/store';
import { routeOf } from '@/lib/util';
import { Icon, Logo } from '../icons';
import { Avatar, VB } from '../ui';
import { ConnectWalletButton, useNeedsWallet } from '../wallet/ConnectWalletButton'; // [A]

const TITLES: Record<string, [string, string]> = {
  explore: ['Explore', 'Creators, tags and keys'],
  markets: ['Markets', 'Every key market in one place'],
  notifications: ['Notifications', ''],
  messages: ['Messages', 'Key rooms and direct messages'],
  tasks: ['Tasks', 'Points become your share of the airdrop'],
  wallet: ['Wallet', 'Balances shown in dollars'],
  leaderboard: ['Leaderboard', ''],
  battles: ['Battles', 'Engagement decides'],
  launchpad: ['Launchpad', 'Your reach, as a token'],
  genesis: ['Genesis pass', '500 soulbound passes'],
  model: ['Open model', 'Public scoring and contracts'],
  staking: ['Staking', 'Stake $SWAY for lower fees'],
  // [B]
  settings: ['Settings', 'Your account and your data'],
  admin: ['Admin', 'Moderation and operations'],
  terms: ['Terms of Service', 'Template: counsel review pending'],
  privacy: ['Privacy Policy', 'Template: counsel review pending'],
  // [D]
  referrals: ['Referrals', 'Your invites, points and fees'],
  watchlist: ['Watchlist', 'Keys you follow, with price alerts'],
};

/** [B] Pages you reach from somewhere else get a Back button (post page, share card). */
function BackHeader({ title, sub }: { title: string; sub?: string }) {
  const back = useGoBack();
  return (
    <div className="ch-row">
      <button className="x-btn" aria-label="Back" onClick={() => back()}>
        <Icon name="arrowL" />
      </button>
      <div style={{ minWidth: 0 }}>
        <h1>{title}</h1>
        {sub ? <div className="sub">{sub}</div> : null}
      </div>
    </div>
  );
}

function MobileTop() {
  const me = useMe().data;
  const F = useFormat();
  const router = useRouter();
  const w = useWallet(!!me?.wallet).data;
  const needWallet = useNeedsWallet();
  return (
    <div className="mtop">
      <button aria-label="Open menu" onClick={() => useUI.setState({ drawer: true })}>
        {me ? (
          <Avatar u={me.user} size={34} />
        ) : (
          <span className="icon-btn">
            <Icon name="menu" />
          </span>
        )}
      </button>
      <Link className="logo" href="/">
        <span className="logo-mk">
          <Logo size={18} />
        </span>
        Sway
      </Link>
      {me && needWallet ? (
        <ConnectWalletButton variant="mobile" />
      ) : me ? (
        <button className="tag line" style={{ height: 32, padding: '0 10px', fontSize: 13 }} onClick={() => router.push('/wallet')}>
          {F.$(w ? weiToEth(w.cashWei) : 0)}
        </button>
      ) : (
        <button className="btn btn-white btn-sm" onClick={() => openModal({ type: 'connect' })}>
          <Icon name="x" size={14} />
          Connect
        </button>
      )}
    </div>
  );
}

function TickerItems({ trades }: { trades: TradeDTO[] }) {
  const F = useFormat();
  const router = useRouter();
  return (
    <>
      {trades.map((t, i) => {
        const k = unitsToKeys(t.units);
        return (
          <span key={`${t.txHash}:${t.logIndex}:${i}`} className="tk" onClick={() => router.push(`/${t.market.handle}`)}>
            <Avatar u={t.trader} size={20} />
            <b>{t.trader.name}</b>
            <span className={t.isBuy ? 'vb-b' : 'vb-s'}>{t.isBuy ? 'bought' : 'sold'}</span>
            {F.keys(k)} key{k === 1 ? '' : 's'} of <b>{t.market.name}</b>
            {F.$(weiToEth(t.baseWei))}
          </span>
        );
      })}
    </>
  );
}

function HomeHeader() {
  const tab = useUI((s) => s.feedTab);
  const trades = (useTrades().data ?? []).slice(0, 20);
  const tabs: Array<[FeedTab, string]> = [
    ['foryou', 'For You'],
    ['trending', 'Trending'],
    ['following', 'Following'],
    ['latest', 'Latest'],
  ];
  return (
    <>
      <div className="tabs" role="tablist">
        {tabs.map(([k, l]) => (
          <button key={k} className={`tab ${tab === k ? 'on' : ''}`} role="tab" aria-selected={tab === k} onClick={() => useUI.setState({ feedTab: k })}>
            {l}
          </button>
        ))}
      </div>
      <div className="ticker" aria-label="Live key trades">
        <div className="tk-track">
          <TickerItems trades={trades} />
          <TickerItems trades={trades} />
        </div>
      </div>
    </>
  );
}

function ProfileHeader({ handle }: { handle: string }) {
  const p = useProfile(handle).data;
  const F = useFormat();
  const back = useGoBack();
  return (
    <div className="ch-row">
      <button className="x-btn" aria-label="Back" onClick={() => back()}>
        <Icon name="arrowL" />
      </button>
      <div style={{ minWidth: 0 }}>
        <h1 className="nm">
          <b>{p?.name || ''}</b>
        </h1>
        <div className="sub">{p ? F.$(weiToEth(p.priceWei)) + ' per key' : ''}</div>
      </div>
    </div>
  );
}

function ThreadHeader({ id }: { id: string }) {
  const router = useRouter();
  const me = useMe().data;
  const isRoom = id.startsWith('room-');
  const handle = isRoom ? id.slice(5) : '';
  const p = useProfile(handle).data;
  const dm = useDm(id, !isRoom && !!me).data;
  const w = isRoom ? p : dm?.thread.with;
  return (
    <div className="ch-row">
      <button className="x-btn" aria-label="Back to messages" onClick={() => router.push('/messages')}>
        <Icon name="arrowL" />
      </button>
      {w && <Avatar u={w} size={34} />}
      <div style={{ minWidth: 0 }}>
        <h1 className="nm" style={{ fontSize: 17 }}>
          <b>{w ? (isRoom ? `${w.name}’s room` : w.name) : ''}</b>
          <VB v={w?.verified} off={w?.official} />
        </h1>
        <div className="sub">{isRoom ? `${p?.holders ?? 0} holders` : w ? '@' + w.handle : ''}</div>
      </div>
    </div>
  );
}

function TitleHeader({ view }: { view: string }) {
  const [t, s] = TITLES[view] ?? ['', ''];
  const me = useMe().data;
  const { readAll } = useActions();
  return (
    <div className="ch-row">
      <div>
        <h1>{t}</h1>
        {s ? <div className="sub">{s}</div> : null}
      </div>
      {view === 'notifications' && me && me.unreadNotifications > 0 ? (
        <button className="btn btn-glass btn-sm" style={{ marginLeft: 'auto' }} onClick={() => readAll()}>
          Mark all read
        </button>
      ) : null}
      {view === 'battles' ? (
        <button className="btn btn-white btn-sm" style={{ marginLeft: 'auto' }} onClick={() => openModal(me ? { type: 'challenge' } : { type: 'connect' })}>
          <Icon name="plus" />
          New challenge
        </button>
      ) : null}
      {view === 'markets' && me ? (
        <Link className="btn btn-glass btn-sm" style={{ marginLeft: 'auto' }} href="/watchlist">
          <Icon name="star" />
          Watchlist
        </Link>
      ) : null}
      {view === 'model' ? (
        <button className="btn btn-glass btn-sm" style={{ marginLeft: 'auto' }} onClick={() => toast('Repo link goes here once it’s public')}>
          <Icon name="github" />
          MIT
        </button>
      ) : null}
    </div>
  );
}

export function CenterHeader() {
  const pathname = usePathname();
  const { view, arg } = routeOf(pathname);
  return (
    <>
      <MobileTop />
      {view === 'home' ? (
        <HomeHeader />
      ) : view === 'profile' && arg ? (
        <ProfileHeader handle={arg} />
      ) : view === 'messages' && arg ? (
        <ThreadHeader id={arg} />
      ) : view === 'post' ? (
        <BackHeader title="Post" />
      ) : view === 'card' && arg ? (
        <BackHeader title="Sway card" sub={'@' + arg} />
      ) : (
        <TitleHeader view={view} />
      )}
    </>
  );
}
