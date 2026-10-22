'use client';
/**
 * [B] Post page: the chain above the post, the post, a reply composer, the author's own thread below it and
 * threaded replies (oldest first).
 */
import type { PostDTO } from '@sway/shared';
import { useParams } from 'next/navigation';
import { Composer } from '@/components/modals/Composer';
import { Icon } from '@/components/icons';
import { Empty, Loading } from '@/components/ui';
import { PostItem } from '@/components/views/Post';
import { useMe } from '@/lib/queries';
import { usePostDetail } from '@/lib/social';
import { openModal } from '@/lib/store';

export default function PostPage() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const { data: d, isPending, error } = usePostDetail(id);
  if (isPending) return <Loading />;
  if (error || !d)
    return (
      <Empty icon="reply" title="This post is unavailable">
        It may have been deleted, or it’s hidden from you.
      </Empty>
    );
  const kids = new Map<string, PostDTO[]>();
  for (const n of d.nested) kids.set(n.parentId!, [...(kids.get(n.parentId!) ?? []), n]);
  return (
    <>
      {d.parentUnavailable && (
        <div className="tomb">
          <Icon name="lock" />
          This post is unavailable.
        </div>
      )}
      {d.parents.map((p) => (
        <PostItem key={p.id} p={p} thread />
      ))}
      <PostItem p={d.post} focus />
      {me.data ? (
        !d.post.locked && <Composer parentId={d.post.id} replyTo={d.post.author.handle} />
      ) : me.isPending ? null : (
        <div className="guest">
          <p>
            <b>Connect X</b> to reply.
          </p>
          <button className="btn btn-white btn-sm" onClick={() => openModal({ type: 'connect' })}>
            <Icon name="x" size={14} />
            Connect X
          </button>
        </div>
      )}
      <div id="replies">
        {d.thread.length > 0 && (
          <div className="rthread" id="selfthread">
            {d.thread.map((t, i) => (
              <PostItem key={t.id} p={t} thread={i < d.thread.length - 1} />
            ))}
          </div>
        )}
        {d.replies.map((r) => {
          const ch = kids.get(r.id) ?? [];
          return (
            <div key={r.id} className="rthread">
              <PostItem p={r} thread={ch.length > 0} />
              {ch.map((c, i) => (
                <PostItem key={c.id} p={c} thread={i < ch.length - 1} />
              ))}
            </div>
          );
        })}
        {!d.replies.length && !d.thread.length && (
          <p className="t3 pad" style={{ fontSize: 14, margin: '8px 0' }}>
            No replies yet.
          </p>
        )}
      </div>
    </>
  );
}
