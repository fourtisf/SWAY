'use client';
import type { BattleDTO, MarketDTO } from '@sway/shared';
import { useRouter } from 'next/navigation';
import { Avatar, Countdown, Loading, VB } from '@/components/ui';
import { useActions } from '@/lib/actions';
import { useFormat } from '@/lib/format';
import { useBattles } from '@/lib/queries';

function Side({ b, c, er, pool, k, lead }: { b: BattleDTO; c: MarketDTO; er: number; pool: number; k: 'a' | 'b'; lead: boolean }) {
  const F = useFormat();
  const router = useRouter();
  const { backSide } = useActions();
  const mine = b.myBacking;
  return (
    <div className={`side-b ${lead ? 'lead' : ''}`}>
      <div className="row clickable" style={{ minWidth: 0 }} onClick={() => router.push(`/${c.handle}`)}>
        <Avatar u={c} size={42} />
        <div style={{ minWidth: 0 }}>
          <div className="nm">
            <b>{c.name}</b>
            <VB v={c.verified} />
          </div>
          <div className="hd">{F.n(c.followers)} followers</div>
        </div>
      </div>
      <div className="between">
        <div>
          <div className="t3" style={{ fontSize: 12, fontWeight: 600 }}>
            Engagement
          </div>
          <div className={`big ${lead ? 'up' : ''}`}>{(er * 100).toFixed(2)}%</div>
        </div>
        <div className="num">
          <small>Backed</small>
          <b>{F.n(pool)}</b>
        </div>
      </div>
      {mine ? (
        mine.side === k ? (
          <span className="tag aqua" style={{ alignSelf: 'flex-start' }}>
            You backed {F.int(mine.amount)} pts
          </span>
        ) : null
      ) : (
        <div className="backs">
          {[100, 500, 1000].map((v) => (
            <button key={v} className="chip" onClick={() => backSide(b.id, k, v)}>
              {F.n(v)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Battle({ b }: { b: BattleDTO }) {
  const F = useFormat();
  const { respond } = useActions();
  const tot = b.erA + b.erB || 1;
  const leadA = b.erA >= b.erB;
  return (
    <div className="glass bt">
      <div className="between" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ fontSize: 16 }}>{b.theme}</h3>
          <div className="t3" style={{ fontSize: 13 }}>
            {(b.stake ? F.int(b.stake) + ' pts each side' : 'Friendly, no stake') + '  ' + b.tag}
          </div>
        </div>
        <span className="tag pink" style={{ flex: 'none' }}>
          <Countdown to={b.endsAt} />
        </span>
      </div>
      <div className="vs">
        <Side b={b} c={b.a} er={b.erA} pool={b.poolA} k="a" lead={leadA} />
        <div className="vs-mid">
          <span>VS</span>
        </div>
        {b.b ? (
          <Side b={b} c={b.b} er={b.erB} pool={b.poolB} k="b" lead={!leadA} />
        ) : (
          <div className="side-b vs-open">Open challenge. Anyone can accept it.</div>
        )}
      </div>
      {b.canRespond && (
        <div className="row" style={{ marginBottom: 12 }}>
          <button className="btn btn-glass btn-sm btn-block" onClick={() => respond(b.id, false)}>
            Decline
          </button>
          <button className="btn btn-white btn-sm btn-block" onClick={() => respond(b.id, true)}>
            Accept
          </button>
        </div>
      )}
      <div className="erbar">
        <i style={{ width: `${((b.erA / tot) * 100).toFixed(1)}%`, background: 'var(--vio)' }} />
        <i style={{ width: `${((b.erB / tot) * 100).toFixed(1)}%`, background: 'var(--pink)' }} />
      </div>
    </div>
  );
}

export default function BattlesPage() {
  const { data } = useBattles();
  const F = useFormat();
  if (!data) return <Loading />;
  return (
    <>
      <div className="glass formula">
        <b>Engagement rate wins, not follower count.</b>
        <div className="t2" style={{ fontSize: 13.5, marginTop: 2 }}>
          Posts are read once from the X API six hours after the 24h window closes.
        </div>
        <code>score = (likes×1 + reposts×2 + replies×3 + quotes×3 + bookmarks×2) ÷ followers</code>
        <div className="row" style={{ gap: 26, marginTop: 14 }}>
          <div>
            <div className="t3" style={{ fontSize: 12, fontWeight: 600 }}>
              Weekly prize pool
            </div>
            <b style={{ fontSize: 19 }}>{F.n(data.weeklyPool)} pts</b>
          </div>
          <div>
            <div className="t3" style={{ fontSize: 12, fontWeight: 600 }}>
              Treasury fee
            </div>
            <b style={{ fontSize: 19 }}>{data.treasuryFeePct}%</b>
          </div>
          <div>
            <div className="t3" style={{ fontSize: 12, fontWeight: 600 }}>
              Live now
            </div>
            <b style={{ fontSize: 19 }}>{data.battles.length}</b>
          </div>
        </div>
      </div>
      {data.battles.map((b) => (
        <Battle key={b.id} b={b} />
      ))}
      <p className="t3" style={{ fontSize: 12.5, padding: '0 18px' }}>
        Winner takes both stakes minus 5%. Backers on the winning side split the losing pool by what they put in. Every Monday 00:00 UTC, half the treasury goes to the week’s top three fighters (50 / 30 /
        20).
      </p>
    </>
  );
}
