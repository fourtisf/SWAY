#!/usr/bin/env bash
# Turns on "Connect X": asks for the X app's keys, writes them into .env and redeploys. Run as root:
#   bash /srv/sway/deploy/set-x-keys.sh
# The keys come from developer.x.com → your app → "Keys and tokens" (OAuth 2.0 Client ID and Client Secret,
# and the app's Bearer Token). The app's callback URL must be <WEB_URL>/api/auth/x/callback.
# Only needed to set or change keys: to deploy code updates run deploy/update.sh, which keeps .env as is.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root: bash $0" >&2; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV="$ROOT/.env"
[ -f "$ENV" ] || { echo "no $ENV: run deploy/install-server.sh first" >&2; exit 1; }

# Enter keeps the value already in .env, so re-running only asks for what you want to change.
current() { sed -n "s/^$1=//p" "$ENV" | tail -1; }
saved() { [ -n "$(current "$1")" ] && echo " [saved, Enter keeps it]" || true; }
read -rp "X OAuth 2.0 Client ID$(saved X_CLIENT_ID): " CID
read -rsp "X OAuth 2.0 Client Secret (hidden)$(saved X_CLIENT_SECRET): " CSECRET; echo
read -rsp "X Bearer Token (hidden)$(saved X_BEARER_TOKEN): " BEARER; echo
read -rp "Your X handle for the admin panel, without @$(saved ADMIN_HANDLES): " ADMIN
[ -n "$CID$(current X_CLIENT_ID)" ] && [ -n "$CSECRET$(current X_CLIENT_SECRET)" ] \
  || { echo "Client ID and Client Secret are required" >&2; exit 1; }

# node writes the values verbatim (tokens can hold characters sed would treat as syntax).
CID="$CID" CSECRET="$CSECRET" BEARER="$BEARER" ADMIN="${ADMIN#@}" node -e '
  const fs = require("fs");
  const file = process.argv[1];
  let s = fs.readFileSync(file, "utf8");
  const web = (s.match(/^WEB_URL=(.*)$/m) || [])[1] || "";
  const set = (k, v) => {
    if (v === undefined || v === "") return;
    const line = `${k}=${v}`;
    s = new RegExp(`^${k}=.*$`, "m").test(s) ? s.replace(new RegExp(`^${k}=.*$`, "m"), () => line) : s.replace(/\n?$/, `\n${line}\n`);
  };
  set("X_CLIENT_ID", process.env.CID);
  set("X_CLIENT_SECRET", process.env.CSECRET);
  set("X_BEARER_TOKEN", process.env.BEARER);
  set("ADMIN_HANDLES", process.env.ADMIN);
  if (web) set("X_CALLBACK_URL", `${web.replace(/\/$/, "")}/api/auth/x/callback`);
  fs.writeFileSync(file, s);
  console.log(`saved. Callback URL to set on developer.x.com: ${web.replace(/\/$/, "")}/api/auth/x/callback`);
' "$ENV"
chown sway:sway "$ENV"
chmod 600 "$ENV"

sudo -iu sway bash "$ROOT/deploy/update.sh"
echo "Done: open the site, click Connect X, then \"Authorize and continue\"."
