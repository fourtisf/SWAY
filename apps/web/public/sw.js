/*
 * Sway service worker: web push only (no caching). Pushes carry no payload (apps/workers/src/push/webpush.ts),
 * so each one fetches the newest unread notification and shows it. Browsers require a visible notification
 * for every push, hence the generic fallback.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const text = (body) => (Array.isArray(body) ? body.map((p) => (p && p.t) || '').join('') : '');

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let n = null;
      try {
        const res = await fetch('/api/notifications?tab=all', { credentials: 'include', headers: { accept: 'application/json' } });
        if (res.ok) n = (await res.json()).find((x) => !x.read) || null;
      } catch (e) {
        /* offline: fall back to the generic text */
      }
      await self.registration.showNotification('Sway', {
        body: n ? text(n.body) : 'You have new activity on Sway.',
        icon: '/push-icon.png',
        badge: '/push-badge.png',
        tag: n ? n.id : 'sway',
        data: { link: (n && n.link) || '/notifications' },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.link) || '/notifications', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of wins) {
        if (new URL(c.url).origin === self.location.origin && 'focus' in c) {
          await c.focus();
          return c.navigate(url);
        }
      }
      return self.clients.openWindow(url);
    })(),
  );
});
