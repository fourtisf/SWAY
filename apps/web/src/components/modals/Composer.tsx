'use client';
import {
  POST_MAX,
  POST_MAX_STAKED,
  POST_MEDIA_MAX,
  THREAD_MAX,
  UPLOAD_MAX_BYTES,
  UPLOAD_MIMES,
  UPLOAD_VIDEO_MAX_BYTES,
  isVideoMime,
  type UploadDTO,
  type Visibility,
} from '@sway/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useActions } from '@/lib/actions';
import { errorMessage, getApi, isAuthRequired } from '@/lib/api';
import { useMe } from '@/lib/queries';
import { refreshPosts } from '@/lib/social';
import { toast } from '@/lib/store';
import { Icon } from '../icons';
import { Avatar, Spinner } from '../ui';

const EMOJI = ['🔥', '🚀', '👀', '💎', '🙌', '😂', '📈', '🫡', '✨', '🤝', '🧠', '⚡'];
// iPhones hand over .mov files; the API stores the ones it can sniff as mp4.
const ACCEPT = [...UPLOAD_MIMES, 'video/quicktime'].join(',');

/** One post of the draft; a thread has several. `up` counts files still uploading. */
type Draft = { key: number; text: string; media: UploadDTO[]; up: number };
const blank = (d: Draft) => !d.text.trim() && !d.media.length;

/**
 * The prototype's composerHtml(): 500 chars (2,000 at staking level ≥1), visibility select, emoji picker.
 * [B] Media tool (up to 4 images or one video, with removable previews) and reply mode (`parentId`): replies
 * keep the parent's page open instead of jumping to the feed. "+" turns a post into a thread, like on X: the
 * tools and the counter act on the post being edited, and the whole thread is created in one request.
 */
export function Composer({
  inModal = false,
  onPosted,
  parentId,
  replyTo,
}: {
  inModal?: boolean;
  onPosted?: () => void;
  parentId?: string;
  replyTo?: string;
}) {
  const me = useMe().data;
  const { post } = useActions();
  const qc = useQueryClient();
  const seq = useRef(0);
  const mk = (): Draft => ({ key: ++seq.current, text: '', media: [], up: 0 });
  const [items, setItems] = useState<Draft[]>(() => [mk()]);
  const [activeKey, setActiveKey] = useState(() => items[0]!.key);
  const [vis, setVis] = useState<Visibility>('public');
  const [emo, setEmo] = useState(false);
  const [busy, setBusy] = useState(false);
  const ta = useRef<HTMLTextAreaElement | null>(null);
  const tas = useRef(new Map<number, HTMLTextAreaElement>());
  const tools = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const maxLen = (me?.stakingLevel ?? 0) >= 1 ? POST_MAX_STAKED : POST_MAX;
  const reply = !!parentId;
  const sfx = inModal ? '2' : reply ? 'r' : '';
  const cur = items.find((x) => x.key === activeKey) ?? items[0]!;
  const multi = items.length > 1;
  const uploading = items.some((x) => x.up > 0);
  const hasVideo = cur.media.some((m) => isVideoMime(m.mime));

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
  const autosize = (el: HTMLTextAreaElement | null | undefined) => {
    if (!el || inModal) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  };
  const patch = (key: number, f: (d: Draft) => Draft) => setItems((xs) => xs.map((x) => (x.key === key ? f(x) : x)));
  const focusSoon = (key: number) => setTimeout(() => tas.current.get(key)?.focus(), 0);
  const reset = () => {
    const d = mk();
    setItems([d]);
    setActiveKey(d.key);
    if (ta.current) ta.current.style.height = '';
  };

  const addPost = () => {
    const d = mk();
    setItems((xs) => {
      const at = xs.findIndex((x) => x.key === cur.key);
      return [...xs.slice(0, at + 1), d, ...xs.slice(at + 1)];
    });
    setActiveKey(d.key);
    focusSoon(d.key);
  };
  const removePost = (key: number) => {
    const at = items.findIndex((x) => x.key === key);
    const prev = items[Math.max(0, at - 1)]!;
    setItems((xs) => xs.filter((x) => x.key !== key));
    if (key === activeKey) {
      setActiveKey(prev.key);
      focusSoon(prev.key);
    }
  };

  const pick = async (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (file.current) file.current.value = '';
    if (!files.length) return;
    const it = cur;
    if (files.some((f) => f.type.startsWith('video/')) && (files.length > 1 || it.media.length || it.up)) {
      toast('A video goes in a post on its own');
      return;
    }
    const room = POST_MEDIA_MAX - it.media.length - it.up;
    if (files.length > room) toast(`Up to ${POST_MEDIA_MAX} images per post`);
    const take = files.slice(0, Math.max(0, room)).filter((f) => {
      const image = f.type.startsWith('image/');
      const ok = f.size <= (image ? UPLOAD_MAX_BYTES : UPLOAD_VIDEO_MAX_BYTES);
      if (!ok) toast(`${f.name} is over ${image ? 5 : 50} MB`);
      return ok;
    });
    if (!take.length) return;
    patch(it.key, (d) => ({ ...d, up: d.up + take.length }));
    try {
      const r = await getApi().upload(take);
      patch(it.key, (d) => ({ ...d, media: [...d.media, ...r.uploads].slice(0, POST_MEDIA_MAX) }));
    } catch (e) {
      if (!isAuthRequired(e)) toast(errorMessage(e));
    }
    patch(it.key, (d) => ({ ...d, up: d.up - take.length }));
  };

  const submit = async () => {
    if (items.some(blank) || busy || uploading) return;
    setBusy(true);
    const [head, ...rest] = items.map((d) => ({ text: d.text.trim(), media: d.media.map((m) => m.url) }));
    if (reply) {
      try {
        await getApi().createPost({
          text: head!.text,
          visibility: 'public',
          parentId,
          ...(head!.media.length ? { media: head!.media } : {}),
        });
        reset();
        toast('Your reply was sent');
        await refreshPosts(qc);
        onPosted?.();
      } catch (e) {
        if (!isAuthRequired(e)) toast(errorMessage(e));
      }
    } else if (await post(head!.text, vis, onPosted, head!.media, rest)) reset();
    setBusy(false);
  };

  return (
    <div className={`composer ${reply ? 'reply' : ''} ${multi ? 'multi' : ''}`}>
      <div className="crows">
        {items.map((d, i) => (
          <div key={d.key} className={`crow ${multi && d.key === cur.key ? 'on' : ''}`}>
            <div className="cav">
              <Avatar u={me.user} size={reply ? 40 : 44} />
            </div>
            <div className="cbody">
              {i === 0 && reply && replyTo && (
                <div className="t3" style={{ fontSize: 14, paddingTop: 8 }}>
                  Replying to <span style={{ color: 'var(--blue)' }}>@{replyTo}</span>
                </div>
              )}
              <textarea
                ref={(el) => {
                  if (el) tas.current.set(d.key, el);
                  else tas.current.delete(d.key);
                  if (i === 0) ta.current = el;
                }}
                id={(inModal ? 'compose2' : reply ? 'reply-box' : 'compose') + (i ? `-${i + 1}` : '')}
                aria-label={multi ? `Post ${i + 1} of ${items.length}` : undefined}
                maxLength={maxLen}
                rows={reply || i > 0 ? 1 : 2}
                placeholder={reply ? 'Post your reply' : i > 0 ? 'Add another post' : 'What’s happening?'}
                value={d.text}
                onFocus={() => setActiveKey(d.key)}
                onChange={(e) => {
                  const v = e.target.value;
                  patch(d.key, (x) => ({ ...x, text: v }));
                  autosize(e.target);
                }}
              />
              {(d.media.length > 0 || d.up > 0) && (
                <div className={`cmedia n${Math.min(4, d.media.length + d.up)}`} aria-label="Attached images">
                  {d.media.map((m, j) => (
                    <div key={m.url} className="cm">
                      {isVideoMime(m.mime) ? (
                        <video src={m.url} aria-label="Attached video" muted playsInline controls preload="metadata" />
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={m.url} alt={`Attached image ${j + 1}`} />
                      )}
                      <button
                        className="cm-x"
                        aria-label={`Remove image ${j + 1}`}
                        onClick={() => patch(d.key, (x) => ({ ...x, media: x.media.filter((y) => y.url !== m.url) }))}
                      >
                        <Icon name="close" />
                      </button>
                    </div>
                  ))}
                  {Array.from({ length: d.up }, (_, j) => (
                    <div key={'u' + j} className="cm busy">
                      <Spinner />
                    </div>
                  ))}
                </div>
              )}
            </div>
            {i > 0 && (
              <button className="crow-x" aria-label={`Remove post ${i + 1}`} onClick={() => removePost(d.key)}>
                <Icon name="close" />
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="comp-foot">
        <div className="tools" ref={tools}>
          <input
            ref={file}
            type="file"
            accept={ACCEPT}
            multiple
            hidden
            id={`img-in${sfx}`}
            aria-label="Choose images"
            onChange={(e) => pick(e.target.files)}
          />
          <button
            className="tool"
            aria-label="Add image"
            title="Photos or a video"
            disabled={hasVideo || cur.media.length + cur.up >= POST_MEDIA_MAX}
            onClick={() => file.current?.click()}
          >
            <Icon name="image" />
          </button>
          <button className="tool" aria-label="Add emoji" onClick={() => !inModal && setEmo(!emo)}>
            <Icon name="smile" />
          </button>
          {!reply && (
            <select className="vis" id={inModal ? 'vis2' : 'vis'} aria-label="Who can see this" value={vis} onChange={(e) => setVis(e.target.value as Visibility)}>
              <option value="public">Everyone</option>
              <option value="holders">Key holders</option>
              <option value="subs">Subscribers</option>
            </select>
          )}
          {!inModal && (
            <div id={reply ? 'emo-r' : 'emo'}>
              {emo && (
                <div className="emoji-pop">
                  {EMOJI.map((x) => (
                    <button
                      key={x}
                      onClick={() => {
                        patch(cur.key, (d) => ({ ...d, text: (d.text + x).slice(0, maxLen) }));
                        setEmo(false);
                        const el = tas.current.get(cur.key);
                        el?.focus();
                        setTimeout(() => autosize(el), 0);
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
          <span className="t3" id={inModal ? 'cnt2' : reply ? 'cntr' : 'cnt'} style={{ fontSize: 12.5 }}>
            {cur.text.length}/{maxLen}
          </span>
          {!reply && (
            <button
              className="tool addpost"
              aria-label="Add post to thread"
              title={items.length >= THREAD_MAX ? `Up to ${THREAD_MAX} posts in a thread` : 'Add another post (thread)'}
              disabled={blank(cur) || items.length >= THREAD_MAX}
              onClick={addPost}
            >
              <Icon name="plus" />
            </button>
          )}
          <button
            className="btn btn-white"
            style={{ height: 38, borderRadius: 999, padding: '0 20px' }}
            id={inModal ? 'postBtn2' : reply ? 'replyBtn' : 'postBtn'}
            disabled={items.some(blank) || busy || uploading}
            onClick={submit}
          >
            {reply ? 'Reply' : multi ? 'Post all' : 'Post'}
          </button>
        </div>
      </div>
    </div>
  );
}
