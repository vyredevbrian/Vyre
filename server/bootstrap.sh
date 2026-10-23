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
docker compose -f "$VYRE_HOME/server/compose.yml" up -d

echo "Done. Point your domains' A records at this server's IP, then: vyre deploy <git-url> <name> <domain>"
