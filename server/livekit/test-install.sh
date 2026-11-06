#!/usr/bin/env bash
# Tests install.sh with stand-ins for docker, ufw, curl and DNS. Usage: bash server/livekit/test-install.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); mkdir -p "$T/bin"; export LOG=$T/log; : > "$LOG"
cat > "$T/bin/docker" <<'X'
#!/bin/bash
echo "docker $*" >> "$LOG"
case "$1 $2" in
  "volume ls") echo "server_caddy_data";;
  "volume inspect") echo "$FAKE_VOL";;
  "ps --filter") echo "livekit-livekit-1  Up 2 seconds";;
esac
exit 0
X
cat > "$T/bin/ufw" <<'X'
#!/bin/bash
echo "ufw $*" >> "$LOG"; [ "$1" = status ] && echo "Status: active"; exit 0
X
cat > "$T/bin/curl" <<'X'
#!/bin/bash
case "$*" in *169.254.169.254*) printf '147.182.171.109';; *"https://lk.example.com/"*) printf 'OK';; *) exit 22;; esac
X
cat > "$T/bin/getent" <<'X'
#!/bin/bash
[ -n "${FAKE_DNS_IP:-}" ] && echo "$FAKE_DNS_IP STREAM $2"; exit 0
X
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH" ALLOW_NONROOT=1 FAKE_VOL="$T/vol/_data" LK_DIR="$T/lk" FAKE_DNS_IP=147.182.171.109
fails=0
ok()  { echo "ok   $1"; }
bad() { echo "FAIL $1"; fails=$((fails+1)); }
chk() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

echo "--- fresh install, certificate not there yet"
OUT=$(LK_DOMAIN=lk.example.com bash "$HERE/install.sh" 2>&1); RC=$?
chk "exits 0" "[ $RC = 0 ]"
chk "opens the four firewall ports" "[ \$(grep -c '^ufw allow' $LOG) = 4 ] && grep -q 'ufw allow 7882/udp' $LOG && grep -q 'ufw allow 7881/tcp' $LOG && grep -q 'ufw allow 3478/udp' $LOG && grep -q 'ufw allow 5349/tcp' $LOG"
chk "config has the requested rtc settings" "grep -q '^  tcp_port: 7881' $T/lk/livekit.yaml && grep -q '^  udp_port: 7882' $T/lk/livekit.yaml && grep -q '^  use_external_ip: true' $T/lk/livekit.yaml"
chk "no TURN block without a certificate" "! grep -q '^turn:' $T/lk/livekit.yaml && echo \"$OUT\" | grep -q 'TURN:                   off'"
chk "keys file is root-only (600)" "[ \$(stat -c %a $T/lk/keys) = 600 ] && [ \$(stat -c %a $T/lk/livekit.yaml) = 600 ] && [ \$(stat -c %a $T/lk) = 700 ]"
KEY=$(cut -d: -f1 "$T/lk/keys"); SECRET=$(cut -d' ' -f2 "$T/lk/keys")
chk "key looks right and secret is 32+ characters" "[[ $KEY =~ ^API[A-Za-z0-9]{12}\$ ]] && [ \${#SECRET} -ge 32 ]"
chk "key and secret are printed once, matching the file" "echo \"$OUT\" | grep -q \"API key:                $KEY\" && echo \"$OUT\" | grep -q \"API secret:             $SECRET\""
chk "prints the wss URL and public IP" "echo \"$OUT\" | grep -q 'wss://lk.example.com' && echo \"$OUT\" | grep -q '147.182.171.109'"
chk "compose file routes the domain to port 7880 and publishes the ports" "grep -q 'caddy: \${LK_DOMAIN}' $T/lk/compose.yml && grep -q 'upstreams 7880' $T/lk/compose.yml && grep -q '7881:7881/tcp' $T/lk/compose.yml && grep -q '7882:7882/udp' $T/lk/compose.yml && grep -q '3478:3478/udp' $T/lk/compose.yml && grep -q '5349:5349/tcp' $T/lk/compose.yml"
chk "started with docker compose" "grep -q 'compose -p livekit' $LOG && grep -q 'up -d' $LOG"
chk ".env holds no secrets" "! grep -qi 'secret\\|API' $T/lk/.env && grep -q 'LK_DOMAIN=lk.example.com' $T/lk/.env"
chk "the secret is not written to the log of commands" "! grep -q \"$SECRET\" $LOG"

echo "--- run again once Caddy has made the certificate"
D="$T/vol/_data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/lk.example.com"; mkdir -p "$D"; echo c > "$D/lk.example.com.crt"; echo k > "$D/lk.example.com.key"
OUT2=$(LK_DOMAIN=lk.example.com bash "$HERE/install.sh" 2>&1); RC=$?
chk "exits 0" "[ $RC = 0 ]"
chk "TURN turned on with container paths" "grep -q '^turn:' $T/lk/livekit.yaml && grep -q 'tls_port: 5349' $T/lk/livekit.yaml && grep -q 'udp_port: 3478' $T/lk/livekit.yaml && grep -q 'domain: lk.example.com' $T/lk/livekit.yaml && grep -q 'cert_file: /caddy-data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/lk.example.com/lk.example.com.crt' $T/lk/livekit.yaml && grep -q 'key_file: /caddy-data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/lk.example.com/lk.example.com.key' $T/lk/livekit.yaml"
chk "keys unchanged and the secret is not printed again" "[ \"\$(cut -d: -f1 $T/lk/keys)\" = $KEY ] && ! echo \"$OUT2\" | grep -q \"$SECRET\" && echo \"$OUT2\" | grep -q 'unchanged'"
chk "reports TURN on" "echo \"$OUT2\" | grep -q 'TURN:                   on'"

echo "--- refusals"
: > "$LOG"; OUT3=$(FAKE_DNS_IP=1.2.3.4 LK_DOMAIN=lk.example.com LK_DIR="$T/lk2" bash "$HERE/install.sh" 2>&1); RC=$?
chk "wrong DNS: stops with code 2 before starting anything" "[ $RC = 2 ] && echo \"$OUT3\" | grep -q 'does not point at this server' && ! grep -q 'compose' $LOG && [ ! -d $T/lk2 ]"
OUT4=$(LK_DOMAIN='bad domain;rm' bash "$HERE/install.sh" 2>&1); RC=$?; chk "a bad domain name is refused" "[ $RC = 1 ]"
OUT5=$(bash "$HERE/install.sh" 2>&1); RC=$?; chk "no domain given is refused" "[ $RC = 1 ]"
OUT6=$(LK_DOMAIN=lk.example.com PUBLIC_IP='1.2.3' LK_DIR="$T/lk3" bash "$HERE/install.sh" 2>&1); RC=$?; chk "a bad public IP is refused" "[ $RC = 1 ]"
echo; [ $fails = 0 ] && echo "all install checks passed" || { echo "$fails check(s) failed"; exit 1; }
