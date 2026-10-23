'use client';
import { CURVE, priceWei, weiToEth } from '@sway/curve';
import { score, scorePoints } from '@sway/scoring';
import Link from 'next/link';
import { useFormat } from '@/lib/format';
import { useUI } from '@/lib/store';
import { TOKEN } from '@/lib/token';

// score.ts as published (packages/scoring/src/score.ts), highlighted like the prototype.
const SCORE_TS = `<span class="k">export function</span> score({ followers, er, ppw, age, verified }) {
  <span class="k">const</span> reach = Math.min(<span class="n">1</span>, Math.log10(followers + <span class="n">1</span>) / Math.log10(<span class="n">5e7</span>));
  <span class="k">const</span> eng   = <span class="n">1</span> - Math.exp(-er * <span class="n">40</span>);  <span class="c">// (likes + 2·reposts + 3·replies) / followers</span>
  <span class="k">const</span> cons  = Math.min(<span class="n">1</span>, ppw / <span class="n">21</span>);
  <span class="k">const</span> auth  = <span class="n">0.6</span> * Math.min(<span class="n">1</span>, age / <span class="n">6</span>) + <span class="n">0.4</span> * (verified ? <span class="n">1</span> : <span class="n">0</span>);
  <span class="k">const</span> raw   = <span class="n">0.35</span>*reach + <span class="n">0.35</span>*eng + <span class="n">0.10</span>*cons + <span class="n">0.20</span>*auth;
  <span class="k">return</span> { score: Math.round(raw * <span class="n">100</span>), value: <span class="n">0.42</span> * followers * raw ** <span class="n">1.6</span> * (<span class="n">0.6</span> + eng) };
}`;

const REPO = `<span class="s">sway/</span>
├─ contracts/  <span class="c">SwayKeys, SwayStaking, GenesisPass, FanEscrow, Launchpad</span>
├─ scoring/    <span class="c">score.ts, the function above</span>
├─ indexer/    <span class="c">chain mirror, 1 min refresh</span>
├─ battles/    <span class="c">X API reader, engagement scoring</span>
└─ web/        <span class="c">this app</span>`;

function Slider({ id, label, val, min, max, step, disp, onChange }: { id: string; label: string; val: number; min: number; max: number; step: number; disp: string; onChange: (v: number) => void }) {
  return (
    <div className="sl">
      <label htmlFor={`m-${id}`}>
        {label}
        <b id={`mv-${id}`}>{disp}</b>
      </label>
      <input type="range" id={`m-${id}`} min={min} max={max} step={step} value={val} onChange={(e) => onChange(+e.target.value)} />
    </div>
  );
}

// Contract reference prices, exact wei (supply in units: 1 key = 100 units).
const keyPrice = (keys: number) => weiToEth(priceWei(BigInt(keys * 100)));

export default function ModelPage() {
  const m = useUI((s) => s.model);
  const F = useFormat();
  const set = (p: Partial<typeof m>) => useUI.setState({ model: { ...m, ...p } });
  const sm = score(m);
  const bars: Array<[string, number, string]> = [
    ['Reach', sm.parts.reach, '35%'],
    ['Engagement', sm.parts.eng, '35%'],
    ['Consistency', sm.parts.cons, '10%'],
    ['Authenticity', sm.parts.auth, '20%'],
  ];
  return (
    <>
      <div style={{ padding: '16px 18px 0' }}>
        <div className="note">Every account is scored by the same published function. Nothing is weighted by hand. Plug in any profile and you get exactly what the indexer computes.</div>
      </div>
      <div className="glass" style={{ margin: '16px 18px', padding: 20 }}>
        <Slider id="followers" label="Followers" val={Math.log10(m.followers)} min={2} max={7.5} step={0.01} disp={F.n(m.followers)} onChange={(v) => set({ followers: Math.round(Math.pow(10, v)) })} />
        <Slider id="er" label="Engagement rate per post" val={m.er * 100} min={0.1} max={8} step={0.1} disp={(m.er * 100).toFixed(1) + '%'} onChange={(v) => set({ er: v / 100 })} />
        <Slider id="ppw" label="Original posts per week" val={m.ppw} min={0} max={40} step={1} disp={String(m.ppw)} onChange={(v) => set({ ppw: v })} />
        <Slider id="age" label="Account age" val={m.age} min={0} max={15} step={0.5} disp={m.age + ' yrs'} onChange={(v) => set({ age: v })} />
        <label className="row" style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--tx2)', cursor: 'pointer' }}>
          <input type="checkbox" id="m-verified" checked={m.verified} onChange={(e) => set({ verified: e.target.checked })} style={{ accentColor: 'var(--vio)', width: 17, height: 17, margin: 0 }} /> Has an X checkmark
        </label>
        <div style={{ height: 1, background: 'var(--stroke)', margin: '18px 0' }} />
        <div id="modelOut">
          <div className="row" style={{ alignItems: 'flex-end', gap: 10 }}>
            <div>
              <div className="t3" style={{ fontSize: 12.5, fontWeight: 600 }}>
                Sway score
              </div>
              <div style={{ fontSize: 58, fontWeight: 800, lineHeight: 0.95, letterSpacing: '-.06em' }}>
                {sm.score}
                <span className="t3" style={{ fontSize: 16, letterSpacing: 0, fontWeight: 600 }}>
                  /100
                </span>
              </div>
            </div>
            <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
              <div style={{ fontSize: 22, fontWeight: 750, letterSpacing: '-.03em' }}>{F.usd(sm.value)}</div>
              <div className="t3" style={{ fontSize: 12 }}>
                reach value
              </div>
              <div className="t3" style={{ fontSize: 12 }}>
                {F.int(scorePoints(sm.score))} points
              </div>
            </div>
          </div>
          <div className="bars">
            {bars.map(([l, v, w]) => (
              <div key={l} className="bar">
                <div className="between">
                  <span>
                    {l} <span className="t3">weight {w}</span>
                  </span>
                  <b style={{ color: 'var(--tx)' }}>{Math.round(v * 100)}</b>
                </div>
                <div className="trk">
                  <i style={{ width: `${Math.round(v * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="sec-h" style={{ paddingTop: 4 }}>
        <h2>score.ts</h2>
        <span className="t3" style={{ fontSize: 13 }}>
          Runs in the indexer and here
        </span>
      </div>
      <div className="code" dangerouslySetInnerHTML={{ __html: SCORE_TS }} />
      <div className="sec-h" style={{ paddingTop: 4 }}>
        <h2>Key contract</h2>
        <span className="t3" style={{ fontSize: 13 }}>
          SwayKeys.sol
        </span>
      </div>
      <div className="glass params">
        <div>
          <span>Curve</span>
          <span>
            K × (supply + {CURVE.O})², K = {CURVE.K}
          </span>
        </div>
        <div>
          <span>First key</span>
          <span>
            {F.eth(keyPrice(1))} ETH ({F.$(keyPrice(1))})
          </span>
        </div>
        <div>
          <span>10th / 100th key</span>
          <span>
            {F.$(keyPrice(10))} / {F.$(keyPrice(100))}
          </span>
        </div>
        <div>
          <span>Minimum trade</span>
          <span>{CURVE.MIN} key</span>
        </div>
        <div>
          <span>Anti-snipe</span>
          <span>max {CURVE.SNIPE_MAX} keys, first 5 min</span>
        </div>
        <div>
          <span>Creator’s first key</span>
          <span>can’t be sold</span>
        </div>
      </div>
      <div className="sec-h" style={{ paddingTop: 4 }}>
        <h2>Where the 10% fee goes</h2>
      </div>
      <div className="flow">
        <div style={{ flex: 6, background: '#1D9BF0' }}>Creator 6%</div>
        <div style={{ flex: 2, background: '#7856FF' }}>Protocol 2%</div>
        <div style={{ flex: 1.3, background: '#00BA7C' }}>Holders 1%</div>
        <div style={{ flex: 1.3, background: '#F91880' }}>Ref 1%</div>
      </div>
      <div style={{ padding: '0 18px 16px' }}>
        <div className="note">
          The 1% holder share is new compared with friend.tech: it streams to everyone holding that creator’s keys, pro rata, claimable onchain. The protocol fee goes half to {TOKEN.name} stakers and half to the
          treasury, and{' '}
          <Link className="lnk" href="/staking" style={{ fontSize: 'inherit' }}>
            staking levels
          </Link>{' '}
          cut it by up to 75%.
        </div>
      </div>
      <div className="sec-h" style={{ paddingTop: 4 }}>
        <h2>Repository</h2>
      </div>
      <div className="code" dangerouslySetInnerHTML={{ __html: REPO }} />
    </>
  );
}
