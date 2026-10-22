'use client';
import {
  POST_MAX,
  POST_MAX_STAKED,
  POST_MEDIA_MAX,
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

/**
 * The prototype's composerHtml(): 500 chars (2,000 at staking level ≥1), visibility select, emoji picker.
 * [B] Media tool (up to 4 images or one video, with removable previews) and reply mode (`parentId`): replies
 * keep the parent's page open instead of jumping to the feed.
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
  const [text, setText] = useState('');
  const [vis, setVis] = useState<Visibility>('public');
  const [emo, setEmo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [media, setMedia] = useState<UploadDTO[]>([]);
  const [uploading, setUploading] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  const tools = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const maxLen = (me?.stakingLevel ?? 0) >= 1 ? POST_MAX_STAKED : POST_MAX;
  const reply = !!parentId;
  const sfx = inModal ? '2' : reply ? 'r' : '';
  const hasVideo = media.some((m) => isVideoMime(m.mime));

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
  const reset = () => {
    setText('');
    setMedia([]);
    if (ta.current) ta.current.style.height = '';
  };

  const pick = async (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (file.current) file.current.value = '';
    if (!files.length) return;
    if (files.some((f) => f.type.startsWith('video/')) && (files.length > 1 || media.length || uploading)) {
      toast('A video goes in a post on its own');
      return;
    }
    const room = POST_MEDIA_MAX - media.length - uploading;
    if (files.length > room) toast(`Up to ${POST_MEDIA_MAX} images per post`);
    const take = files.slice(0, Math.max(0, room)).filter((f) => {
      const image = f.type.startsWith('image/');
      const ok = f.size <= (image ? UPLOAD_MAX_BYTES : UPLOAD_VIDEO_MAX_BYTES);
      if (!ok) toast(`${f.name} is over ${image ? 5 : 50} MB`);
      return ok;
    });
    if (!take.length) return;
    setUploading((n) => n + take.length);
    try {
      const r = await getApi().upload(take);
      setMedia((m) => [...m, ...r.uploads].slice(0, POST_MEDIA_MAX));
    } catch (e) {
      if (!isAuthRequired(e)) toast(errorMessage(e));
    }
    setUploading((n) => n - take.length);
  };

  const submit = async () => {
    const t = text.trim();
    if ((!t && !media.length) || busy || uploading) return;
    setBusy(true);
    const urls = media.map((m) => m.url);
    if (reply) {
      try {
        await getApi().createPost({ text: t, visibility: 'public', parentId, ...(urls.length ? { media: urls } : {}) });
        reset();
        toast('Your reply was sent');
        await refreshPosts(qc);
        onPosted?.();
      } catch (e) {
        if (!isAuthRequired(e)) toast(errorMessage(e));
      }
    } else if (await post(t, vis, onPosted, urls)) reset();
    setBusy(false);
  };

  return (
    <div className={`composer ${reply ? 'reply' : ''}`}>
      <Avatar u={me.user} size={reply ? 40 : 44} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {reply && replyTo && (
          <div className="t3" style={{ fontSize: 14, paddingTop: 8 }}>
            Replying to <span style={{ color: 'var(--blue)' }}>@{replyTo}</span>
          </div>
        )}
        <textarea
          ref={ta}
          id={inModal ? 'compose2' : reply ? 'reply-box' : 'compose'}
          maxLength={maxLen}
          rows={reply ? 1 : 2}
          placeholder={reply ? 'Post your reply' : 'What’s happening?'}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            autosize();
          }}
        />
        {(media.length > 0 || uploading > 0) && (
          <div className={`cmedia n${Math.min(4, media.length + uploading)}`} aria-label="Attached images">
            {media.map((m, i) => (
              <div key={m.url} className="cm">
                {isVideoMime(m.mime) ? (
                  <video src={m.url} aria-label="Attached video" muted playsInline controls preload="metadata" />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={m.url} alt={`Attached image ${i + 1}`} />
                )}
                <button className="cm-x" aria-label={`Remove image ${i + 1}`} onClick={() => setMedia((x) => x.filter((y) => y.url !== m.url))}>
                  <Icon name="close" />
                </button>
              </div>
            ))}
            {Array.from({ length: uploading }, (_, i) => (
              <div key={'u' + i} className="cm busy">
                <Spinner />
              </div>
            ))}
          </div>
        )}
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
              disabled={hasVideo || media.length + uploading >= POST_MEDIA_MAX}
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
            <span className="t3" id={inModal ? 'cnt2' : reply ? 'cntr' : 'cnt'} style={{ fontSize: 12.5 }}>
              {text.length}/{maxLen}
            </span>
            <button
              className="btn btn-white"
              style={{ height: 38, borderRadius: 999, padding: '0 20px' }}
              id={inModal ? 'postBtn2' : reply ? 'replyBtn' : 'postBtn'}
              disabled={(!text.trim() && !media.length) || busy || uploading > 0}
              onClick={submit}
            >
              {reply ? 'Reply' : 'Post'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
