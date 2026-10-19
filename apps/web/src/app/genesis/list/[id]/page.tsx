'use client';
/** [C] The frozen Genesis list (GenesisPass.commitSnapshot points here: /genesis/list/<snapshot id>). */
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Icon } from '@/components/icons';
import { Avatar, Empty, Loading } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { fmtTokens } from '@/lib/launch-actions';
import { useGenesisList } from '@/lib/queries';
import { toast } from '@/lib/store';

function takenLabel(iso: string) {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  return `Frozen on ${date} at ${time} UTC`;
}

export default function GenesisListPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isError } = useGenesisList(decodeURIComponent(id ?? ''));
  const F = useFormat();
  if (isError)
    return (
      <Empty
        icon="gem"
        title="No list here yet"
        action={
          <Link className="btn btn-glass" href="/genesis">
            Back to Genesis
          </Link>
        }
      >
        The list is published at the snapshot. Until then the ranking is live on the Genesis page.
      </Empty>
    );
  if (!data) return <Loading />;
  const mine = data.rows.find((r) => r.me);
  return (
    <>
      <div style={{ padding: '18px 18px 6px' }}>
        <div className="between" style={{ alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}>
            <h2 className="big-h" style={{ fontSize: 24, marginBottom: 4 }}>
              The Genesis list
            </h2>
            <div className="t3" style={{ fontSize: 13 }}>
              {takenLabel(data.takenAt)}
            </div>
          </div>
          <Link className="btn btn-glass btn-sm" href="/genesis">
            <Icon name="arrowL" />
            Genesis
          </Link>
        </div>
      </div>
      <div className="grid3" style={{ padding: '10px 16px 4px' }}>
        <div className="glass stat">
          <small>Passes</small>
          <b>{F.int(data.count)}</b>
        </div>
        <div className="glass stat">
          <small>Minted</small>
          <b>{F.int(data.minted)}</b>
        </div>
        <div className="glass stat">
          <small>Pool</small>
          <b>{fmtTokens(data.poolUnits)}</b>
        </div>
      </div>
      <div style={{ padding: '10px 16px 4px' }}>
        <div className="note" style={{ fontSize: 13 }}>
          <span>List hash </span>
          <button
            className="lnk"
            style={{ fontFamily: 'var(--mono)', fontSize: 12.5, wordBreak: 'break-all', textAlign: 'left' }}
            onClick={() => {
              navigator.clipboard?.writeText(data.listHash).catch(() => null);
              toast('List hash copied');
            }}
          >
            {data.listHash}
          </button>
          <br />
          Committed onchain to the Genesis pass contract before minting. Pass number = rank, sent to each wallet below.
        </div>
      </div>
      {mine && (
        <div className="glass" style={{ margin: '10px 16px 4px', padding: '14px 16px' }}>
          <div className="between">
            <span className="t2" style={{ fontWeight: 600 }}>
              Your pass
            </span>
            <b style={{ fontSize: 22, letterSpacing: '-.03em' }}>#{String(mine.rank).padStart(4, '0')}</b>
          </div>
          <div className="t3" style={{ fontSize: 13, marginTop: 2 }}>
            {`${mine.sharePct.toFixed(4)}% of the pool. ${mine.minted ? 'Minted to ' + mine.walletShort : 'Minting within 24 hours'}.`}
          </div>
        </div>
      )}
      <div className="sec-h">
        <h2>Ranked by points</h2>
        <span className="t3" style={{ fontSize: 13 }}>
          {data.published ? 'Published' : 'Draft'}
        </span>
      </div>
      <div className="tr th" style={{ gridTemplateColumns: '64px minmax(0,1fr) auto' }}>
        <span>Rank</span>
        <span>Member</span>
        <span style={{ textAlign: 'right' }}>Share</span>
      </div>
      {data.rows.map((r) => (
        <div key={r.rank} className={`tr ${r.me ? 'me' : ''}`} style={{ gridTemplateColumns: '64px minmax(0,1fr) auto' }}>
          <span className="rk">#{String(r.rank).padStart(4, '0')}</span>
          <Link href={`/${r.user.handle}`} className="row" style={{ minWidth: 0 }}>
            <Avatar u={r.user} size={36} />
            <div style={{ minWidth: 0 }}>
              <div className="nm">
                <b>{r.user.name}</b>
                {r.minted ? (
                  <span className="tag aqua" style={{ marginLeft: 6 }}>
                    Minted
                  </span>
                ) : null}
              </div>
              <div className="hd" style={{ fontSize: 13.5 }}>{`@${r.user.handle}  ${r.walletShort}`}</div>
            </div>
          </Link>
          <div className="num">
            <b>{r.sharePct.toFixed(4)}%</b>
            <small>{`${F.n(r.points)} pts, ${fmtTokens(r.units)}`}</small>
          </div>
        </div>
      ))}
    </>
  );
}
