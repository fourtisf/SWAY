'use client';
/**
 * [B] The "···" post menu. Own post: Delete, Boost, Copy link. Others: Copy link, Report post, Block @handle.
 * Admins also get Hide post (or Unhide). The official account (and admins) can pin its posts to the top of Home.
 */
import { OFFICIAL_HANDLE, type PostDTO } from '@sway/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMe } from '@/lib/queries';
import { useSocialActions } from '@/lib/social';
import { openModal } from '@/lib/store';
import { Icon, type IconName } from '../icons';

function Item({ icon, children, onClick, danger }: { icon: IconName; children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button className={`pmi ${danger ? 'danger' : ''}`} role="menuitem" onClick={onClick}>
      <Icon name={icon} />
      {children}
    </button>
  );
}

export function PostMenu({ p }: { p: PostDTO }) {
  const [open, setOpen] = useState(false);
  const me = useMe().data;
  const s = useSocialActions();
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('click', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  const h = p.author.handle;
  const canPin = !!p.author.official && h === OFFICIAL_HANDLE && !p.parentId && (p.mine || !!me?.isAdmin);
  return (
    <span className="pm-wrap" ref={box}>
      <button className="more" aria-label="More" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="dots" size={18} />
      </button>
      {open && (
        <div className="pmenu" role="menu" aria-label="Post menu">
          {p.mine ? (
            <>
              <Item icon="trash" danger onClick={run(() => openModal({ type: 'deletePost', postId: p.id }))}>
                Delete
              </Item>
              <Item icon="rocket" onClick={run(() => openModal({ type: 'boost', postId: p.id }))}>
                Boost
              </Item>
              <Item icon="link" onClick={run(() => s.copyLink(p))}>
                Copy link
              </Item>
            </>
          ) : (
            <>
              <Item icon="link" onClick={run(() => s.copyLink(p))}>
                Copy link
              </Item>
              <Item icon="flag" onClick={run(() => s.openReport({ postId: p.id, handle: h }))}>
                Report post
              </Item>
              {!p.author.official && (
                <Item icon="block" onClick={run(() => s.block(h))}>
                  Block @{h}
                </Item>
              )}
            </>
          )}
          {canPin && (
            <Item icon="pin" onClick={run(() => s.pin(p))}>
              {p.pinned ? 'Unpin from Home' : 'Pin to Home'}
            </Item>
          )}
          {me?.isAdmin && (
            <Item icon={p.hidden ? 'eye' : 'eyeOff'} onClick={run(() => s.hide(p))}>
              {p.hidden ? 'Unhide post' : 'Hide post'}
            </Item>
          )}
        </div>
      )}
    </span>
  );
}
