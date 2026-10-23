#!/usr/bin/env bash
# Smoke test for the Vercel-compatible runtime against the bundled fixture site. Usage: bash runtime/vercel/test/run.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
SITE_ROOT="$here/fixture-site" PORT=3499 node "$here/../server.js" >/dev/null 2>&1 &
pid=$!; trap 'kill $pid 2>/dev/null' EXIT; sleep 1.5
fail=0
check() { local want=$1 got=$2 label=$3; if [ "$want" = "$got" ]; then echo "ok   $label"; else echo "FAIL $label (want $want, got $got)"; fail=1; fi; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
check 200 "$(code localhost:3499/)" "home"
check 308 "$(code localhost:3499/blog)" "trailing slash redirect"
check 308 "$(code localhost:3499/old)" "vercel.json redirect"
check 404 "$(code localhost:3499/api/_private)" "underscore files are not routes"
check 500 "$(code localhost:3499/api/boom)" "handler error is a 500"
check 400 "$(code -X POST -H 'Content-Type: application/json' -d '{bad' localhost:3499/api/echo)" "bad json"
check '{"id":"42"}' "$(curl -s localhost:3499/api/items/42)" "dynamic route"
check '{"id":"7"}' "$(curl -sL localhost:3499/shop/7)" "rewrite to function"
check 201 "$(code -X POST -H 'Content-Type: application/json' -d '{"a":1}' localhost:3499/api/echo)" "res.status().json()"
exit $fail
