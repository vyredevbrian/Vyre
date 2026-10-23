#!/usr/bin/env bash
# Create the droplet and have it set itself up on first boot. Run on your own computer.
#   export TOKEN=<DigitalOcean API token, read+write>   (never paste it into chat or commit it)
#   SSH_KEY=<key fingerprint or id from DO > Settings > Security> DASH_DOMAIN=deploy.vyrechain.com bash server/create-droplet.sh
set -euo pipefail

: "${TOKEN:?export TOKEN first}"
: "${SSH_KEY:?set SSH_KEY (fingerprint or id); without it you could not log in}"
: "${DASH_DOMAIN:?set DASH_DOMAIN, e.g. deploy.vyrechain.com}"
REGION=${REGION:-mkc1}
SIZE=${SIZE:-s-2vcpu-4gb}        # 2 vCPU / 4 GB. A newer slug copied from the DO panel also works.
NAME=${NAME:-deploy-vyre}
BRANCH=${VYRE_BRANCH:-main}
RAW=https://raw.githubusercontent.com/vyredevbrian/vyre/$BRANCH/server/bootstrap.sh

[[ $DASH_DOMAIN =~ ^[A-Za-z0-9.-]+$ && $BRANCH =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "bad DASH_DOMAIN or VYRE_BRANCH" >&2; exit 1; }
case $SSH_KEY in *[!0-9a-f:]*) echo "SSH_KEY should be the key's fingerprint or numeric id" >&2; exit 1;; esac

USER_DATA="#!/bin/bash\nexport DASH_DOMAIN=$DASH_DOMAIN VYRE_BRANCH=$BRANCH\ncurl -fsSL $RAW | bash\n"
case $SSH_KEY in *[!0-9]*) KEY="\"$SSH_KEY\"";; *) KEY=$SSH_KEY;; esac

resp=$(curl -fsS -X POST https://api.digitalocean.com/v2/droplets \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d "{\"name\":\"$NAME\",\"region\":\"$REGION\",\"size\":\"$SIZE\",\"image\":\"ubuntu-24-04-x64\",\"ssh_keys\":[$KEY],\"backups\":true,\"ipv6\":true,\"monitoring\":true,\"tags\":[\"vyre\"],\"user_data\":\"$USER_DATA\"}")
id=$(printf '%s' "$resp" | sed -n 's/.*"droplet":{"id":\([0-9]*\).*/\1/p')
[ -n "$id" ] || { echo "Unexpected response: $resp" >&2; exit 1; }
echo "Droplet $id created. Waiting for its IP..."

for _ in $(seq 1 30); do
  sleep 5
  ip=$(curl -fsS -H "Authorization: Bearer $TOKEN" "https://api.digitalocean.com/v2/droplets/$id" \
    | sed -n 's/.*"ip_address":"\([0-9.]*\)","netmask":[0-9]*,"gateway":"[0-9.]*","type":"public".*/\1/p' | head -1)
  [ -n "$ip" ] && break
done
echo "IP: ${ip:-not assigned yet, check the DO panel}"
echo "1) DNS: add an A record  ${DASH_DOMAIN%%.*}  ->  ${ip:-<ip>}"
echo "2) Setup takes ~5 min. Then: ssh root@${ip:-<ip>} 'cat /opt/vyre/.env'  for the dashboard password and MCP token."
