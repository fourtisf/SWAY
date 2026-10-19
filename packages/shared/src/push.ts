import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefs } from './api';

/**
 * Browser push services we deliver to. The endpoint comes from the browser, so anything else is refused (the
 * workers would otherwise POST to arbitrary URLs).
 */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];

/** `devHosts` ("host:port") allows a local test receiver; never set it in production. */
export function pushEndpointAllowed(endpoint: string, devHosts: readonly string[] = []): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (devHosts.includes(u.host)) return true;
  return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some((r) => r.test(u.hostname));
}

/** User.notifPrefs (JSON or null) with defaults for missing keys. */
export function resolveNotificationPrefs(raw: unknown): NotificationPrefs {
  const out = { ...DEFAULT_NOTIFICATION_PREFS };
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(out) as Array<keyof NotificationPrefs>) {
      const v = (raw as Record<string, unknown>)[k];
      if (typeof v === 'boolean') out[k] = v;
    }
  }
  return out;
}
