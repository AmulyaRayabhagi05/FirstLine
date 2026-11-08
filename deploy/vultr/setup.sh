#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 Vultr server, run by `deploy.sh <ip> --setup <site-host>`
# after it has uploaded the code to /srv/firstline/repo (the GitHub repo is private, so the server
# never clones it). Installs Node 22, Caddy and the firewall, creates the firstline user and the
# services. Secrets (agents/.env, the worker token) are copied in by deploy.sh, never by this.
set -euo pipefail
SITE_HOST="${1:?usage: setup.sh <site-host, e.g. 203-0-113-7.sslip.io>}"
export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y ca-certificates curl gnupg ufw debian-keyring debian-archive-keyring apt-transport-https

# Node 22
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# Caddy (official repo)
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

# Firewall: SSH and the website only. The Nemotron tunnel and the worker listen on localhost.
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# App user and folders (the code is already in /srv/firstline/repo)
id firstline >/dev/null 2>&1 || useradd --create-home --shell /bin/bash firstline
mkdir -p /srv/firstline/web /etc/firstline
chown -R firstline:firstline /srv/firstline
chgrp firstline /etc/firstline
chmod 750 /etc/firstline

# Dedicated SSH key for the Brev tunnel (its public half goes on the Brev box)
sudo -u firstline mkdir -p /home/firstline/.ssh
[ -f /home/firstline/.ssh/brev_ed25519 ] || sudo -u firstline ssh-keygen -t ed25519 -N '' -C firstline-vultr-brev -f /home/firstline/.ssh/brev_ed25519

# Website + services
REPO_DIR=/srv/firstline/repo/deploy/vultr
cp "$REPO_DIR/Caddyfile" /etc/caddy/Caddyfile
mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironment=SITE_HOST=%s\n' "$SITE_HOST" > /etc/systemd/system/caddy.service.d/site.conf
cp "$REPO_DIR/firstline-brev-tunnel.service" "$REPO_DIR/firstline-worker.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable caddy firstline-brev-tunnel firstline-worker
systemctl restart caddy

echo
echo "Brev tunnel public key (deploy.sh adds it to the Brev box):"
cat /home/firstline/.ssh/brev_ed25519.pub
