#!/usr/bin/env bash
# Build the dashboard against SpacetimeDB Maincloud and publish it to the Vultr server.
#
#   deploy/vultr/deploy.sh [server-ip]      (default 207.148.5.196)
#
# Needs SSH to root@<server-ip> and web/.env.production.local (git-ignored) with:
#   VITE_SPACETIME_HOST=https://maincloud.spacetimedb.com
#   VITE_SPACETIME_DB=firstline
#   VITE_SPACETIME_TOKEN=<Maincloud VIEWER token>   (never a staff token: it ships in the bundle)
# Only the static site is touched; the worker and the Caddy config on the server are left alone.
set -euo pipefail
IP="${1:-207.148.5.196}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENVF="$ROOT/web/.env.production.local"
SSH="ssh -o StrictHostKeyChecking=accept-new root@$IP"

[ -f "$ENVF" ] || { echo "missing web/.env.production.local"; exit 1; }
grep -q '^VITE_SPACETIME_HOST=https://maincloud.spacetimedb.com' "$ENVF" || { echo "VITE_SPACETIME_HOST must be Maincloud"; exit 1; }
grep -q '^VITE_SPACETIME_TOKEN=.' "$ENVF" || { echo "VITE_SPACETIME_TOKEN (viewer) is missing"; exit 1; }

echo "== build dashboard"
npm --prefix "$ROOT/web" run build

# The resident app (sign-up, "I'm safe", "I need help") is served at /app/ from the same site.
# It ships no token: every phone creates its own identity and only sees its own records.
echo "== build resident app (/app/)"
[ -d "$ROOT/mobile/node_modules" ] || npm --prefix "$ROOT/mobile" ci
npm --prefix "$ROOT/mobile" run build
rm -rf "$ROOT/web/dist/app" && cp -r "$ROOT/mobile/dist" "$ROOT/web/dist/app"

echo "== upload to $IP:/srv/firstline/web"
tar -C "$ROOT/web/dist" -czf - . | $SSH 'set -e
  rm -rf /srv/firstline/web.new && mkdir -p /srv/firstline/web.new
  tar -xzf - -C /srv/firstline/web.new
  rm -rf /srv/firstline/web.old
  [ -d /srv/firstline/web ] && mv /srv/firstline/web /srv/firstline/web.old
  mv /srv/firstline/web.new /srv/firstline/web
  chown -R firstline:firstline /srv/firstline/web && chmod -R a+rX /srv/firstline'
SITE="https://$(echo "$IP" | tr . -).sslip.io"
curl -s -o /dev/null -w "dashboard: %{http_code}\n" "$SITE/"
curl -s -o /dev/null -w "resident app: %{http_code}\n" "$SITE/app/"
