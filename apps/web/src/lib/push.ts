'use client';
/** Browser side of web push: the service worker (public/sw.js) and the PushManager subscription. */
import type { PushSubscribeBody } from '@sway/shared';

export const pushSupported = (): boolean =>
  typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

const keyBytes = (b64u: string): Uint8Array => {
  const s = atob(b64u.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64u.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

async function registration(): Promise<ServiceWorkerRegistration> {
  const reg = (await navigator.serviceWorker.getRegistration('/')) ?? (await navigator.serviceWorker.register('/sw.js', { scope: '/' }));
  await navigator.serviceWorker.ready;
  return reg;
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Throws Error('denied') when the member blocks notifications. */
export async function enablePush(publicKey: string): Promise<PushSubscribeBody> {
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('denied');
  const reg = await registration();
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource }));
  const j = sub.toJSON();
  return { endpoint: j.endpoint!, keys: { p256dh: j.keys!.p256dh!, auth: j.keys!.auth! } };
}

/** Unsubscribes this browser; returns the endpoint so the API can forget it. */
export async function disablePush(): Promise<string | null> {
  const sub = await currentPushSubscription();
  if (!sub) return null;
  await sub.unsubscribe();
  return sub.endpoint;
}
