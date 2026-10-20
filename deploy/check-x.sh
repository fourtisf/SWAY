#!/usr/bin/env bash
# Checks the "Connect X" setup from the server, without printing any secret. Run as root:
#   bash /srv/sway/deploy/check-x.sh
# 1. what the API sends to X (client ID type, callback URL, scopes)
# 2. whether X accepts the Client ID + Client Secret (a dummy code is exchanged: X says the code is invalid
#    when the keys are right, and "unauthorized" when they are wrong)
# 3. whether the callback URL is reachable from the internet
# and prints the exact values to enter in the X developer console.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV="$ROOT/.env"
[ -r "$ENV" ] || { echo "cannot read $ENV (run as root)" >&2; exit 1; }

ENV_FILE="$ENV" node - <<'EOF'
const fs = require('fs');
const env = Object.fromEntries(
  fs.readFileSync(process.env.ENV_FILE, 'utf8').split('\n')
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const web = (env.WEB_URL || '').replace(/\/$/, '');
const cid = env.X_CLIENT_ID || '';
const secret = env.X_CLIENT_SECRET || '';
const callback = env.X_CALLBACK_URL || `${web}/api/auth/x/callback`;
const ok = (m) => console.log(`  OK    ${m}`);
const bad = (m) => console.log(`  FIX   ${m}`);
const info = (m) => console.log(`        ${m}`);

(async () => {
  console.log('\n1. Settings in .env');
  if (!cid) bad('X_CLIENT_ID is empty: run deploy/set-x-keys.sh');
  else {
    let kind = '';
    try { kind = Buffer.from(cid, 'base64').toString('utf8'); } catch {}
    if (/:1:ci$/.test(kind)) ok('X_CLIENT_ID is an OAuth 2.0 Client ID (Web App, confidential)');
    else if (/:1:/.test(kind)) bad(`X_CLIENT_ID is an OAuth 2.0 Client ID of another app type (${kind.split(':').slice(1).join(':')}): set Type of App = Web App`);
    else bad('X_CLIENT_ID does not look like an OAuth 2.0 Client ID (the API Key is a different value): copy it from "OAuth 2.0 Client ID and Client Secret"');
  }
  secret ? ok('X_CLIENT_SECRET is set') : bad('X_CLIENT_SECRET is empty: run deploy/set-x-keys.sh');
  callback === `${web}/api/auth/x/callback` ? ok(`callback URL: ${callback}`) : bad(`X_CALLBACK_URL (${callback}) differs from ${web}/api/auth/x/callback`);

  console.log('\n2. What the API sends to X');
  try {
    const r = await fetch('http://127.0.0.1:4000/api/auth/x/start', { redirect: 'manual' });
    const loc = r.headers.get('location');
    if (!loc) bad(`/api/auth/x/start answered ${r.status} without a redirect (is sway-api running? pm2 status)`);
    else {
      const u = new URL(loc);
      ok(`authorize URL host: ${u.host}${u.pathname}`);
      info(`redirect_uri = ${u.searchParams.get('redirect_uri')}`);
      info(`scope        = ${u.searchParams.get('scope')}`);
      info(`PKCE         = ${u.searchParams.get('code_challenge_method')}`);
    }
  } catch (e) { bad(`API not reachable on 127.0.0.1:4000 (${e.message})`); }

  console.log('\n3. Client ID + Client Secret, checked by X');
  if (cid && secret) {
    try {
      const r = await fetch('https://api.x.com/2/oauth2/token', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: 'Basic ' + Buffer.from(`${cid}:${secret}`).toString('base64'),
        },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: 'sway-check', redirect_uri: callback, code_verifier: 'x'.repeat(43), client_id: cid }),
      });
      const j = await r.json().catch(() => ({}));
      const said = `${j.error || r.status}: ${j.error_description || ''}`.trim();
      if (/authorization code/i.test(j.error_description || '')) ok('X accepts the Client ID and Client Secret');
      else if (r.status === 401 || /unauthorized|client/i.test(j.error || '')) bad(`X rejects the keys (${said}): regenerate the Client Secret and run deploy/set-x-keys.sh`);
      else info(`X answered ${said}`);
    } catch (e) { bad(`cannot reach api.x.com (${e.message})`); }
  }

  console.log('\n4. Callback reachable from the internet');
  try {
    const r = await fetch(`${callback}?error=access_denied`, { redirect: 'manual' });
    const loc = r.headers.get('location') || '';
    r.status === 302 && loc.includes('auth_error=') ? ok(`${callback} answers (302 → site)`) : bad(`${callback} answered ${r.status}: check nginx and pm2`);
  } catch (e) { bad(`${callback} unreachable (${e.message})`); }

  console.log(`
5. In console.x.com → your app → User authentication settings → Set up / Edit, enter exactly:
     App permissions .......... Read
     Type of App .............. Web App, Automated App or Bot
     Callback URI / Redirect .. ${callback}
     Website URL .............. ${web}
   Save, wait a minute, then click Connect X on the site.
   If every line above is OK and X still says "Something went wrong", X is refusing this app or the X account
   you are logged in with: try another X account in a private window, or create a new app with the same values.
`);
})();
EOF
