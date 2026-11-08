#!/usr/bin/env bash
# Deploy FirstLine to the Vultr server from a laptop checkout (Git Bash, WSL, macOS or Linux).
#
#   deploy/vultr/deploy.sh <server-ip>            build + upload the dashboard, update the worker
#   deploy/vultr/deploy.sh <server-ip> --brev     also (re)authorize the server's tunnel key on Brev
#
# Needs: SSH to root@<server-ip> with your key, web/.env.production.local holding the Maincloud
# VIEWER token (never a staff token: it ships in the public bundle), agents/.env and
# agents/.spacetime-token (the Maincloud worker token). --brev also needs WSL with the brev CLI
# logged in (hope-nemotron-host in ~/.brev/ssh_config).
set -euo pipefail
IP="${1:?usage: deploy.sh <server-ip> [--brev]}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SSH="ssh -o StrictHostKeyChecking=accept-new root@$IP"

[ -f "$ROOT/web/.env.production.local" ] || { echo "missing web/.env.production.local (VITE_SPACETIME_HOST/DB/TOKEN)"; exit 1; }
[ -f "$ROOT/agents/.env" ] || { echo "missing agents/.env"; exit 1; }
[ -f "$ROOT/agents/.spacetime-token" ] || { echo "missing agents/.spacetime-token (Maincloud worker token)"; exit 1; }
if grep -q '127.0.0.1\|localhost' "$ROOT/web/.env.production.local"; then
  echo "web/.env.production.local points at a local database; set VITE_SPACETIME_HOST to Maincloud"; exit 1
fi

echo "== build dashboard"
npm --prefix "$ROOT/web" run build

echo "== upload dashboard"
tar -C "$ROOT/web/dist" -czf - . | $SSH 'set -e; rm -rf /srv/firstline/web.new; mkdir -p /srv/firstline/web.new; tar -xzf - -C /srv/firstline/web.new; rm -rf /srv/firstline/web.old; [ -d /srv/firstline/web ] && mv /srv/firstline/web /srv/firstline/web.old; mv /srv/firstline/web.new /srv/firstline/web; chown -R firstline:firstline /srv/firstline/web'

echo "== update worker code and secrets"
$SSH 'set -e; sudo -u firstline git -C /srv/firstline/repo pull --ff-only; sudo -u firstline npm ci --silent --prefix /srv/firstline/repo/agents'
tar -C "$ROOT/agents" -czf - .env .spacetime-token | $SSH 'set -e; cd /srv/firstline/repo/agents; tar -xzf -; chown firstline:firstline .env .spacetime-token; chmod 600 .env .spacetime-token'

if [ "${2:-}" = "--brev" ]; then
  echo "== authorize the server's tunnel key on the Brev box"
  PUB="$($SSH 'cat /home/firstline/.ssh/brev_ed25519.pub')"
  BREV_HOST="$(wsl -d Ubuntu -- bash -lc "awk '/^Host hope-nemotron-host/{f=1} f&&/Hostname/{print \$2; exit}' ~/.brev/ssh_config" | tr -d '\r\0')"
  BREV_USER="$(wsl -d Ubuntu -- bash -lc "awk '/^Host hope-nemotron-host/{f=1} f&&/User /{print \$2; exit}' ~/.brev/ssh_config" | tr -d '\r\0')"
  printf '%s\n' "$PUB" | wsl -d Ubuntu -- ssh hope-nemotron-host 'mkdir -p ~/.ssh; chmod 700 ~/.ssh; read -r k; grep -qxF "$k" ~/.ssh/authorized_keys 2>/dev/null || echo "$k" >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys'
  $SSH "printf 'BREV_HOST=%s\nBREV_USER=%s\n' '$BREV_HOST' '$BREV_USER' > /etc/firstline/brev.env; chmod 640 /etc/firstline/brev.env; chgrp firstline /etc/firstline/brev.env"
fi

echo "== restart services"
$SSH 'systemctl restart firstline-brev-tunnel; sleep 3; systemctl restart firstline-worker caddy; sleep 5; systemctl --no-pager --lines=0 status firstline-brev-tunnel firstline-worker caddy | grep -E "●|Active:"'
echo "done"
