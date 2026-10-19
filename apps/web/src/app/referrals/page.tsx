'use client';
/** [D] Referral dashboard: invite link, who joined through it, points and onchain referral fees. */
import { weiToEth } from '@sway/curve';
import Link from 'next/link';
import { Icon } from '@/components/icons';
import { Avatar, Empty, Loading, NeedUser, VB } from '@/components/ui';
import { useReferrals } from '@/lib/engage';
import { useFormat } from '@/lib/format';
import { useMe } from '@/lib/queries';
import { toast } from '@/lib/store';

const STATUS: Record<'pending' | 'credited' | 'rejected', [string, string]> = {
  credited: ['aqua', 'Credited'],
  pending: ['line', 'Pending'],
  rejected: ['red', 'Not eligible'],
};

export default function ReferralsPage() {
  const me = useMe();
  const F = useFormat();
  const { data: r } = useReferrals(!!me.data);
  if (me.isPending) return <Loading />;
  if (!me.data) return <NeedUser title="Connect X to invite friends" text="Share your link. Every verified member who joins through it earns you points and half of the 1% referral fee on their trades." />;
  if (!r) return <Loading />;
  const copy = () => {
    navigator.clipboard?.writeText(r.link).catch(() => null);
    toast('Invite link copied');
  };
  const share = 'https://x.com/intent/post?text=' + encodeURIComponent(`I’m on Sway. Join with my link and get your Sway score: ${r.link}`);
  return (
    <div className="refs">
      <div className="glass ref-hero">
        <div className="t3" style={{ fontSize: 12.5, fontWeight: 600 }}>
          Your invite link
        </div>
        <div className="ref-link">
          <span>{r.link.replace(/^https?:\/\//, '')}</span>
          <button className="btn btn-glass btn-sm" onClick={copy}>
            <Icon name="copy" /> Copy
          </button>
          <a className="btn btn-white btn-sm" href={share} target="_blank" rel="noopener noreferrer">
            <Icon name="x" /> Share
          </a>
        </div>
        <div className="ref-stats">
          <div>
            <b>{F.int(r.invited)}</b>
            <span>Joined</span>
          </div>
          <div>
            <b>{F.int(r.credited)}</b>
            <span>Verified</span>
          </div>
          <div>
            <b>{F.n(r.points)}</b>
            <span>Points earned</span>
          </div>
          <div>
            <b>{F.eth(weiToEth(BigInt(r.referralEarnedWei)))}</b>
            <span>ETH in referral fees</span>
          </div>
        </div>
        {BigInt(r.referralPendingWei) > 0n && (
          <div className="between" style={{ marginTop: 12, fontSize: 13.5 }}>
            <span className="t2">
              {F.eth(weiToEth(BigInt(r.referralPendingWei)))} ETH ({F.$(weiToEth(BigInt(r.referralPendingWei)))}) is waiting in your earnings
            </span>
            <Link className="btn btn-buy btn-sm" href="/wallet">
              Claim
            </Link>
          </div>
        )}
      </div>

      <div className="glass" style={{ margin: '0 18px 16px', padding: 18 }}>
        <h3 style={{ fontSize: 15, marginBottom: 6 }}>How invites pay</h3>
        {[
          ['Each verified invite', `+${F.int(r.pointsPerInvite)} points`],
          ['Your invitee gets', '+100 points'],
          ['Referral fee on their trades', 'half of the 1%'],
          ['Referral fee on trades in their market', 'half of the 1%'],
          ['Invites credited per day', `${r.creditedToday} of ${r.dailyCap} today`],
        ].map(([a, b]) => (
          <div key={a} className="between" style={{ padding: '9px 0', borderBottom: '1px solid var(--stroke)', fontSize: 13.5 }}>
            <span className="t2">{a}</span>
            <b>{b}</b>
          </div>
        ))}
        <p className="t3" style={{ fontSize: 12.5, margin: '12px 0 0' }}>
          An invite counts once the new member’s X account is at least 30 days old, has 50+ followers and a checkmark, and
          isn’t flagged as a bot. ETH figures are estimates from indexed trades; what you can claim is read from the chain.
        </p>
      </div>

      <div className="sec-h" style={{ padding: '0 18px' }}>
        <h2>People you invited</h2>
      </div>
      {r.rows.length ? (
        <div id="ref-rows">
          {r.rows.map((x) => {
            const [cls, label] = STATUS[x.status];
            return (
              <Link key={x.handle} href={`/${x.handle}`} className="tr ref-r">
                <span className="row" style={{ minWidth: 0 }}>
                  <Avatar u={x} size={40} />
                  <span style={{ minWidth: 0 }}>
                    <span className="nm">
                      <b>{x.name}</b>
                      <VB v={x.verified} />
                    </span>
                    <span className="hd">
                      @{x.handle}
                      {x.reason ? ` · ${x.reason}` : ''}
                    </span>
                  </span>
                </span>
                <span className="t2" style={{ fontSize: 13, textAlign: 'right' }}>
                  {F.eth(weiToEth(BigInt(x.volumeWei)))} ETH
                  <br />
                  <span className="t3" style={{ fontSize: 12 }}>
                    traded
                  </span>
                </span>
                <span className={`tag ${cls}`}>{label}</span>
              </Link>
            );
          })}
        </div>
      ) : (
        <Empty icon="users" title="No invites yet">
          Share your link on X. People who join through it show up here.
        </Empty>
      )}
    </div>
  );
}
