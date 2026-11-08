#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 Vultr server. Run as root:  bash setup.sh <site-host>
# Installs Node 22, Caddy and the firewall, creates the firstline user, clones the repo and
# installs the worker. Secrets (agents/.env, the worker token, the Brev key) are copied in by
# deploy.sh afterwards, never by this script.
set -euo pipefail
SITE_HOST="${1:?usage: setup.sh <site-host, e.g. 203-0-113-7.sslip.io>}"
REPO="${REPO:-https://github.com/Spikestar05/FirstLine.git}"
export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y ca-certificates curl gnupg git ufw debian-keyring debian-archive-keyring apt-transport-https

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

# App user, folders, repo
id firstline >/dev/null 2>&1 || useradd --create-home --shell /bin/bash firstline
mkdir -p /srv/firstline/web /etc/firstline
chown -R firstline:firstline /srv/firstline
chmod 750 /etc/firstline
if [ ! -d /srv/firstline/repo/.git ]; then
  sudo -u firstline git clone "$REPO" /srv/firstline/repo
else
  sudo -u firstline git -C /srv/firstline/repo pull --ff-only
fi
sudo -u firstline npm ci --prefix /srv/firstline/repo/agents

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
