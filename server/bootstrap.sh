#!/usr/bin/env bash
# Run once as root on a fresh Ubuntu 24.04 DigitalOcean droplet:
#   curl -fsSL https://raw.githubusercontent.com/vyredevbrian/vyre/main/server/bootstrap.sh | bash
set -euo pipefail

VYRE_HOME=/opt/vyre
REPO_URL=${VYRE_REPO:-https://github.com/vyredevbrian/vyre.git}

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git ufw fail2ban unattended-upgrades

# Docker
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh

# Nixpacks: builds projects that have no Dockerfile (Next.js, Node, Python, static, ...)
command -v nixpacks >/dev/null || curl -fsSL https://nixpacks.com/install.sh | bash

# Swap so builds don't OOM on small droplets
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Firewall: SSH + web only
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80,443/tcp
ufw --force enable

# Platform
if [ -d "$VYRE_HOME/.git" ]; then git -C "$VYRE_HOME" pull --ff-only; else git clone "$REPO_URL" "$VYRE_HOME"; fi
ln -sf "$VYRE_HOME/bin/vyre" /usr/local/bin/vyre
mkdir -p "$VYRE_HOME/apps"
docker network inspect vyre >/dev/null 2>&1 || docker network create vyre
[ -n "${DASH_DOMAIN:-}" ] || { echo "Set DASH_DOMAIN, e.g. DASH_DOMAIN=deploy.example.com bash bootstrap.sh" >&2; exit 1; }
if [ ! -f "$VYRE_HOME/.env" ]; then
  DASH_PASSWORD=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)
  printf 'DASH_DOMAIN=%s\nDASH_PASSWORD=%s\n' "$DASH_DOMAIN" "$DASH_PASSWORD" > "$VYRE_HOME/.env"
  chmod 600 "$VYRE_HOME/.env"
  echo "Dashboard password: $DASH_PASSWORD  (also in $VYRE_HOME/.env)"
fi
grep -q '^MCP_TOKEN=' "$VYRE_HOME/.env" || {
  MCP_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)
  echo "MCP_TOKEN=$MCP_TOKEN" >> "$VYRE_HOME/.env"
  echo "MCP token: $MCP_TOKEN  (endpoint https://$DASH_DOMAIN/mcp)"
}
docker compose --env-file "$VYRE_HOME/.env" -f "$VYRE_HOME/server/compose.yml" up -d

echo "Done. Point your domains' A records at this server's IP, then open https://$DASH_DOMAIN"
