'use client';
/** [B] Post menu sheets: boost confirm, report (post or account), delete confirm. */
import { weiToEth } from '@sway/curve';
import { REPORT_REASONS, type ReportReason } from '@sway/shared';
import { useState } from 'react';
import { useFormat } from '@/lib/format';
import { useBoostQuote, useSocialActions } from '@/lib/social';
import { closeModal } from '@/lib/store';
import { Icon } from '../icons';
import { Spinner } from '../ui';

function Head({ title }: { title: string }) {
  return (
    <div className="m-h">
      <h3>{title}</h3>
      <button className="x-btn" aria-label="Close" onClick={closeModal}>
        <Icon name="close" />
      </button>
    </div>
  );
}

export function BoostSheet({ postId }: { postId: string }) {
  const q = useBoostQuote().data;
  const F = useFormat();
  const s = useSocialActions();
  const [busy, setBusy] = useState(false);
  const eth = q ? weiToEth(q.wei) : 0;
  return (
    <>
      <Head title="Boost post" />
      <div className="m-b">
        <p className="t2" style={{ margin: '0 0 14px', fontSize: 14.5 }}>
          Boosted posts rank higher in For You and carry a <b style={{ color: 'var(--tx)' }}>Boosted</b> label for {q?.hours ?? 24} hours.
        </p>
        <div className="sum">
          <div className="sum-r tot">
            <span>You pay</span>
            <span>
              <b>{q ? `$${q.usd.toFixed(2)}` : '…'}</b>
              <small>{q ? `${F.eth(eth)} ETH` : ''}</small>
            </span>
          </div>
          <div className="sum-r">
            <span>Boost length</span>
            <span>{q?.hours ?? 24} hours</span>
          </div>
          <div className="sum-r">
            <span>Paid to</span>
            <span>Sway treasury</span>
          </div>
        </div>
        <button
          className="btn btn-white btn-lg btn-block"
          disabled={!q || !q.treasury || busy}
          onClick={async () => {
            setBusy(true);
            await s.boost(postId);
            setBusy(false);
          }}
        >
          {busy ? <Spinner size={16} color="#fff" /> : <Icon name="rocket" />}
          {q ? `Boost for $${q.usd.toFixed(2)}` : 'Boost'}
        </button>
        <p className="disc">
          {q && !q.treasury ? 'Boosts aren’t available on this network yet. ' : ''}Paid in ETH from your active wallet at today’s price. Boosts are final and don’t change who can
          see the post.
        </p>
      </div>
    </>
  );
}

const REASONS: Record<ReportReason, [string, string]> = {
  spam: ['Spam', 'Scams, fake engagement, repeated posts or misleading links'],
  abuse: ['Abuse or harassment', 'Insults, threats, or targeting someone'],
  impersonation: ['Impersonation', 'Pretending to be someone else'],
  other: ['Something else', 'Anything else our moderators should see'],
};

export function ReportModal({ postId, handle }: { postId?: string; handle: string }) {
  const s = useSocialActions();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Head title={postId ? 'Report post' : `Report @${handle}`} />
      <div className="m-b">
        <p className="t2" style={{ margin: '0 0 12px', fontSize: 14.5 }}>
          What’s wrong with {postId ? 'this post' : 'this account'}?
        </p>
        <div className="opts" role="radiogroup" aria-label="Reason">
          {REPORT_REASONS.map((r) => (
            <button key={r} className={`opt ${reason === r ? 'on' : ''}`} role="radio" aria-checked={reason === r} onClick={() => setReason(r)}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <b>{REASONS[r][0]}</b>
                <small>{REASONS[r][1]}</small>
              </span>
              <span className="rd" />
            </button>
          ))}
        </div>
        <label className="lbl" htmlFor="rp-n" style={{ marginTop: 14 }}>
          Add details (optional)
        </label>
        <textarea className="field" id="rp-n" rows={3} maxLength={1000} style={{ height: 'auto', padding: '10px 12px', resize: 'none', marginBottom: 16 }} value={note} onChange={(e) => setNote(e.target.value)} />
        <button
          className="btn btn-white btn-lg btn-block"
          disabled={!reason || busy}
          onClick={async () => {
            setBusy(true);
            await s.report({ postId, handle }, reason!, note);
            setBusy(false);
          }}
        >
          Send report
        </button>
        <p className="disc">Reports are private. The account won’t know who reported it.</p>
      </div>
    </>
  );
}

export function DeletePostModal({ postId }: { postId: string }) {
  const s = useSocialActions();
  const [busy, setBusy] = useState(false);
  return (
    <div className="m-b" style={{ paddingTop: 20 }}>
      <h3 style={{ fontSize: 20, fontWeight: 800, margin: '0 0 8px' }}>Delete post?</h3>
      <p className="t2" style={{ margin: '0 0 20px', fontSize: 15 }}>
        This can’t be undone. It will be removed from your profile, the feeds of your followers and holders, and search.
      </p>
      <button
        className="btn btn-sell btn-lg btn-block"
        style={{ marginBottom: 10 }}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await s.deletePost(postId, { leave: typeof window !== 'undefined' && window.location.pathname === `/post/${postId}` });
          setBusy(false);
        }}
      >
        Delete
      </button>
      <button className="btn btn-glass btn-lg btn-block" onClick={closeModal}>
        Cancel
      </button>
    </div>
  );
}
