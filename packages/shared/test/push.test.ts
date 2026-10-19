import { describe, expect, it } from 'vitest';
import { pushEndpointAllowed, resolveNotificationPrefs } from '../src/push';
import { DEFAULT_NOTIFICATION_PREFS } from '../src/api';

describe('push endpoints', () => {
  it('accepts the browser push services only', () => {
    expect(pushEndpointAllowed('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(pushEndpointAllowed('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(pushEndpointAllowed('https://web.push.apple.com/QH')).toBe(true);
    expect(pushEndpointAllowed('https://db5p.notify.windows.com/w/?token=1')).toBe(true);
    expect(pushEndpointAllowed('http://fcm.googleapis.com/fcm/send/abc')).toBe(false);
    expect(pushEndpointAllowed('https://fcm.googleapis.com:8443/x')).toBe(false);
    expect(pushEndpointAllowed('https://evil.example/fcm.googleapis.com')).toBe(false);
    expect(pushEndpointAllowed('https://fcm.googleapis.com.evil.example/x')).toBe(false);
    expect(pushEndpointAllowed('https://u:p@fcm.googleapis.com/x')).toBe(false);
    expect(pushEndpointAllowed('http://127.0.0.1:9911/push')).toBe(false);
    expect(pushEndpointAllowed('http://127.0.0.1:9911/push', ['127.0.0.1:9911'])).toBe(true);
    expect(pushEndpointAllowed('not a url')).toBe(false);
  });
  it('fills preference defaults', () => {
    expect(resolveNotificationPrefs(null)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(resolveNotificationPrefs({ trade: false, push: false, junk: 1, mention: 'no' })).toEqual({ ...DEFAULT_NOTIFICATION_PREFS, trade: false, push: false });
  });
});
