/**
 * Minimal Web Push sender (RFC 8030 + VAPID, RFC 8292) with node:crypto. Pushes carry no payload, so no
 * message encryption is needed: the service worker wakes up and fetches the newest notification itself, and
 * the push service never sees notification text.
 */
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';

export interface VapidKeys {
  /** Uncompressed P-256 public key (65 bytes), base64url: what browsers get as applicationServerKey. */
  publicKey: string;
  /** Private scalar d (32 bytes), base64url. */
  privateKey: string;
  /** mailto: or https: contact for the push services. */
  subject: string;
}

const b64u = (b: Buffer) => b.toString('base64url');

export function generateVapidKeys(subject = 'mailto:ops@sway.fam'): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x!, 'base64url'), Buffer.from(pub.y!, 'base64url')]);
  return { publicKey: b64u(raw), privateKey: priv.d!, subject };
}

/** ES256 JWT for one push service origin, valid 12 hours. */
export function vapidJwt(audience: string, v: VapidKeys, now = Date.now()): string {
  const pub = Buffer.from(v.publicKey, 'base64url');
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID public key must be an uncompressed P-256 point');
  const key = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: v.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) },
    format: 'jwk',
  });
  const enc = (o: object) => b64u(Buffer.from(JSON.stringify(o)));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: v.subject })}`;
  return `${unsigned}.${b64u(sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }))}`;
}

/** Sends one payload-less push. Topic "sway" lets the push service collapse undelivered ones. */
export async function sendPush(endpoint: string, v: VapidKeys, ttlSeconds = 86_400): Promise<number> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      TTL: String(ttlSeconds),
      Urgency: 'normal',
      Topic: 'sway',
      Authorization: `vapid t=${vapidJwt(new URL(endpoint).origin, v)}, k=${v.publicKey}`,
      'Content-Length': '0',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  await res.arrayBuffer().catch(() => undefined);
  return res.status;
}
