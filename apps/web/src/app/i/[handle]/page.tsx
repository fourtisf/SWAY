'use client';
import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Loading } from '@/components/ui';
import { saveRef } from '@/lib/referral';

/** Invite link (swayfamily.com/i/:handle): remember the inviter, then land on Home. */
export default function InvitePage() {
  const { handle } = useParams<{ handle: string }>();
  const router = useRouter();
  useEffect(() => {
    saveRef(decodeURIComponent(handle));
    router.replace('/');
  }, [handle, router]);
  return <Loading />;
}
