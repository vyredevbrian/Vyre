#!/usr/bin/env bash
# Install or update LiveKit on this server. Run as root:  LK_DOMAIN=lk.example.com bash /opt/vyre/server/livekit/install.sh
# Safe to run again: it keeps the existing API key and secret, and only adds what is missing.
set -euo pipefail

LK_DOMAIN=${LK_DOMAIN:-}
LK_DIR=${LK_DIR:-/opt/livekit}
LK_IMAGE=${LK_IMAGE:-livekit/livekit-server:latest}
HERE=$(cd "$(dirname "$0")" && pwd)
fail() { echo "ERROR: $*" >&2; exit 1; }

[ -n "$LK_DOMAIN" ] || fail "set LK_DOMAIN, for example: LK_DOMAIN=lk.example.com bash $0"
[[ $LK_DOMAIN =~ ^([a-z0-9-]+\.)+[a-z]{2,}$ ]] || fail "LK_DOMAIN is not a valid domain name"
[ "$(id -u)" = 0 ] || [ -n "${ALLOW_NONROOT:-}" ] || fail "run as root"
for t in docker openssl curl getent; do command -v "$t" >/dev/null || fail "$t is not installed"; done
docker network inspect vyre >/dev/null 2>&1 || fail "the 'vyre' Docker network is missing (is Vyre installed?)"

PUBLIC_IP=${PUBLIC_IP:-$(curl -fsS -m 5 http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address 2>/dev/null || curl -fsS -m 8 https://api.ipify.org 2>/dev/null || true)}
[[ $PUBLIC_IP =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || fail "could not work out this server's public IP; run again with PUBLIC_IP=1.2.3.4"

# The domain must already point here. Without that Caddy cannot get its certificate, and Let's Encrypt blocks a name for an hour after a few failures.
RESOLVED=$(getent ahostsv4 "$LK_DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u || true)
if [ -z "${SKIP_DNS_CHECK:-}" ] && ! grep -qx "$PUBLIC_IP" <<<"$RESOLVED"; then
  echo "STOP: $LK_DOMAIN does not point at this server ($PUBLIC_IP) yet."
  echo "Add an A record named '${LK_DOMAIN%%.*}' with value $PUBLIC_IP at your DNS provider, wait a few minutes, then run this again."
  exit 2
fi

echo "== 1. Firewall"
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
  for r in 7881/tcp 7882/udp 3478/udp 5349/tcp; do ufw allow "$r" >/dev/null; done
  echo "ufw: opened 7881/tcp 7882/udp 3478/udp 5349/tcp"
else
  echo "ufw is not active on this server, nothing to open there"
fi
echo "(Docker publishes the same four ports on its own, which also goes around ufw. A cloud firewall at the hosting provider, if one is attached, must allow them too.)"

echo "== 2. Keys and config"
mkdir -p "$LK_DIR"; chmod 700 "$LK_DIR"
NEWKEYS=0
if [ ! -s "$LK_DIR/keys" ]; then
  RAW=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9'); KEY="API${RAW:0:12}"
  RAW=$(openssl rand -base64 96 | tr -dc 'A-Za-z0-9'); SECRET="${RAW:0:48}"   # 48 characters; LiveKit wants at least 32
  [ "${#SECRET}" -ge 32 ] || fail "could not make a secret"
  ( umask 077; printf '%s: %s\n' "$KEY" "$SECRET" > "$LK_DIR/keys" ); NEWKEYS=1
fi
KEYLINE=$(cat "$LK_DIR/keys")

CADDY_VOLUME=${CADDY_VOLUME:-$(docker volume ls -q | grep -E 'caddy_data$' | head -1 || true)}
[ -n "$CADDY_VOLUME" ] || fail "could not find Caddy's data volume"
printf 'LK_DOMAIN=%s\nLK_IMAGE=%s\nCADDY_VOLUME=%s\n' "$LK_DOMAIN" "$LK_IMAGE" "$CADDY_VOLUME" > "$LK_DIR/.env"
cp "$HERE/compose.yml" "$LK_DIR/compose.yml"

# TURN over TLS needs a certificate for the domain; Caddy makes it once the domain is being served. Use it when it exists.
write_config() { # $1: the certificate's path on this server, or empty for no TURN
  local crt=${1:-} key=""
  [ -z "$crt" ] || key="${crt%.crt}.key"
  ( umask 077; {
    echo "port: 7880"
    echo "rtc:"
    echo "  tcp_port: 7881"
    echo "  udp_port: 7882"
    echo "  use_external_ip: true"
    echo "keys:"
    echo "  $KEYLINE"
    echo "logging:"
    echo "  level: info"
    if [ -n "$crt" ]; then
      echo "turn:"
      echo "  enabled: true"
      echo "  domain: $LK_DOMAIN"
      echo "  tls_port: 5349"
      echo "  udp_port: 3478"
      echo "  cert_file: /caddy-data/${crt#*/_data/}"
      echo "  key_file: /caddy-data/${key#*/_data/}"
    fi
  } > "$LK_DIR/livekit.yaml.new" )
  mv "$LK_DIR/livekit.yaml.new" "$LK_DIR/livekit.yaml"
}
find_cert() { # prints the certificate path if both the certificate and its key exist
  local mp crt; mp=$(docker volume inspect --format '{{.Mountpoint}}' "$CADDY_VOLUME" 2>/dev/null || true)
  [ -n "$mp" ] || return 0
  crt=$(find "$mp" -name "$LK_DOMAIN.crt" 2>/dev/null | head -1 || true)
  if [ -n "$crt" ] && [ -f "${crt%.crt}.key" ]; then echo "$crt"; fi
  return 0
}
CRT=$(find_cert)
write_config "$CRT"; TURN=off; [ -z "$CRT" ] || TURN=on

echo "== 3. Start LiveKit"
up() { docker compose -p livekit -f "$LK_DIR/compose.yml" --env-file "$LK_DIR/.env" up -d --force-recreate; }
up
sleep 4
docker ps --filter name=livekit --format '{{.Names}}  {{.Status}}'

echo "== 4. Wait for the HTTPS address"
OK=0
for i in $(seq 1 30); do
  if [ "$(curl -fsS -m 5 "https://$LK_DOMAIN/" 2>/dev/null || true)" = "OK" ]; then OK=1; break; fi
  sleep 4
done
[ "$OK" = 1 ] && echo "https://$LK_DOMAIN/ answers OK" || echo "WARNING: https://$LK_DOMAIN/ did not answer OK yet (certificate may still be issuing; check: docker logs --tail 30 vyre-caddy)"

if [ "$TURN" = off ]; then
  CRT=$(find_cert)
  if [ -n "$CRT" ]; then
    echo "== 5. Turn on TURN (the certificate now exists)"
    write_config "$CRT"; up; sleep 4; TURN=on
  else
    echo "TURN is not on yet: the certificate has not appeared. Run this script again in a few minutes."
  fi
fi

echo
echo "================ LIVEKIT READY ================"
echo "URL (for the browser):  wss://$LK_DOMAIN"
echo "Server public IP:       $PUBLIC_IP"
echo "TURN:                   $TURN"
if [ "$NEWKEYS" = 1 ]; then
  echo "API key:                ${KEYLINE%%:*}"
  echo "API secret:             ${KEYLINE#*: }"
  echo "(shown once; stored root-only in $LK_DIR/keys. Keep the secret on your app's server, never in browser code.)"
else
  echo "API key and secret:     unchanged (read them as root with: cat $LK_DIR/keys)"
fi
