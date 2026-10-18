'use client';
import { POST_MAX, POST_MAX_STAKED, type Visibility } from '@sway/shared';
import { useEffect, useRef, useState } from 'react';
import { useActions } from '@/lib/actions';
import { useMe } from '@/lib/queries';
import { toast } from '@/lib/store';
import { Icon } from '../icons';
import { Avatar } from '../ui';

const EMOJI = ['🔥', '🚀', '👀', '💎', '🙌', '😂', '📈', '🫡', '✨', '🤝', '🧠', '⚡'];

/** The prototype's composerHtml(): 500 chars (2,000 at staking level ≥1), visibility select, emoji picker. */
export function Composer({ inModal = false, onPosted }: { inModal?: boolean; onPosted?: () => void }) {
  const me = useMe().data;
  const { post } = useActions();
  const [text, setText] = useState('');
  const [vis, setVis] = useState<Visibility>('public');
  const [emo, setEmo] = useState(false);
  const [busy, setBusy] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const tools = useRef<HTMLDivElement>(null);
  const maxLen = (me?.stakingLevel ?? 0) >= 1 ? POST_MAX_STAKED : POST_MAX;

  useEffect(() => {
    if (inModal) ta.current?.focus();
  }, [inModal]);
  useEffect(() => {
    if (!emo) return;
    const onDoc = (e: MouseEvent) => {
      if (!tools.current?.contains(e.target as Node)) setEmo(false);
    };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [emo]);

  if (!me) return null;
  const autosize = () => {
    const el = ta.current;
    if (!el || inModal) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  };
  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    const ok = await post(t, vis, onPosted);
    setBusy(false);
    if (ok) {
      setText('');
      if (ta.current) ta.current.style.height = '';
    }
  };

  return (
    <div className="composer">
      <Avatar u={me.user} size={44} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <textarea
          ref={ta}
          id={inModal ? 'compose2' : 'compose'}
          maxLength={maxLen}
          rows={2}
          placeholder="What’s happening?"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            autosize();
          }}
        />
        <div className="comp-foot">
          <div className="tools" ref={tools}>
            <button className="tool" aria-label="Add image" onClick={() => toast('Image upload opens soon')}>
              <Icon name="image" />
            </button>
            <button className="tool" aria-label="Add emoji" onClick={() => !inModal && setEmo(!emo)}>
              <Icon name="smile" />
            </button>
            <select className="vis" id={inModal ? 'vis2' : 'vis'} aria-label="Who can see this" value={vis} onChange={(e) => setVis(e.target.value as Visibility)}>
              <option value="public">Everyone</option>
              <option value="holders">Key holders</option>
              <option value="subs">Subscribers</option>
            </select>
            {!inModal && (
              <div id="emo">
                {emo && (
                  <div className="emoji-pop">
                    {EMOJI.map((x) => (
                      <button
                        key={x}
                        onClick={() => {
                          setText((t) => (t + x).slice(0, maxLen));
                          setEmo(false);
                          ta.current?.focus();
                          setTimeout(autosize, 0);
                        }}
                      >
                        {x}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="row">
            <span className="t3" id={inModal ? 'cnt2' : 'cnt'} style={{ fontSize: 12.5 }}>
              {text.length}/{maxLen}
            </span>
            <button className="btn btn-white" style={{ height: 38, borderRadius: 999, padding: '0 20px' }} id={inModal ? 'postBtn2' : 'postBtn'} disabled={!text.trim() || busy} onClick={submit}>
              Post
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
