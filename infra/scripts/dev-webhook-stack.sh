#!/usr/bin/env bash
# Bring up everything Paystack needs to reach us, from nothing, in one command.
#
# WHY THIS EXISTS: this sandbox resets often — docker, node_modules, running
# processes and the tunnel all disappear together. Rebuilding by hand takes
# several minutes and, worse, a half-restored stack answers 200 from ngrok's
# own error page while the gateway behind it is dead. Paystack then records a
# delivery failure and it looks like a webhook bug.
#
#   NGROK_AUTHTOKEN=... NGROK_DOMAIN=your.ngrok-free.dev \
#     bash infra/scripts/dev-webhook-stack.sh
#
# Idempotent: safe to re-run, reuses whatever is already healthy.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"
export TMPDIR="${TMPDIR:-$HOME/.tmp}"; mkdir -p "$TMPDIR"

PORT="${GATEWAY_PORT:-3000}"
NGROK="${NGROK_BIN:-$HOME/ngrok}"
D="docker"; sudo -n true 2>/dev/null && D="sudo -n docker"

say() { printf '  %-32s %s\n' "$1" "$2"; }

# --- deps -----------------------------------------------------------------
[ -d node_modules ] || { npm ci >/dev/null 2>&1; }
say "node_modules" "$([ -d node_modules ] && echo ok || echo MISSING)"

# --- .env -----------------------------------------------------------------
[ -f .env ] || { cp .env.example .env; say ".env" "created from template — FILL IN YOUR KEYS"; }
set -a; . ./.env; set +a
say "paystack key" "$([ -n "${PAYSTACK_SECRET_KEY:-}" ] && echo "${PAYSTACK_SECRET_KEY:0:11}…" || echo 'NOT SET')"

# --- postgres -------------------------------------------------------------
pgrep -x dockerd >/dev/null || { sudo -n dockerd >/tmp/dockerd.log 2>&1 & sleep 12; }
if ! $D exec besonc-pay pg_isready -U besonc -q 2>/dev/null; then
  $D rm -f besonc-pay >/dev/null 2>&1
  $D run -d --name besonc-pay -p 5432:5432 \
    -e POSTGRES_USER=besonc -e POSTGRES_PASSWORD=besonc_dev -e POSTGRES_DB=besonc \
    postgres:16-alpine >/dev/null 2>&1
  for _ in $(seq 1 30); do $D exec besonc-pay pg_isready -U besonc -q 2>/dev/null && break; sleep 2; done
  for f in apps/svc-payment/migrations/*.sql; do
    cat "$f" | $D exec -i besonc-pay psql -U besonc -d besonc -q 2>&1 | grep '^ERROR' | grep -v 'already exists' | head -1
  done
fi
say "postgres" "$($D exec besonc-pay pg_isready -U besonc -q 2>/dev/null && echo ok || echo FAILED)"

# --- services -------------------------------------------------------------
# Redis/RabbitMQ deliberately blank: the webhook path does not need them, and
# a service that waits on a broker that is not there never becomes healthy.
start() { # name main port
  curl -sf -o /dev/null "http://127.0.0.1:$3/health" 2>/dev/null && { say "$1" "already up"; return; }
  (NODE_ENV=development PORT="$3" REDIS_URL= RABBITMQ_URL= RATE_LIMIT_SCALE=100 \
    nohup setsid npx tsx "$2" > "/tmp/$1.log" 2>&1 &)
  for _ in $(seq 1 30); do
    curl -sf -o /dev/null "http://127.0.0.1:$3/health" 2>/dev/null && { say "$1" "started"; return; }
    sleep 1
  done
  say "$1" "FAILED — see /tmp/$1.log"; tail -3 "/tmp/$1.log"
}
start payment apps/svc-payment/src/main.ts 3007
start gateway apps/gateway/src/main.ts "$PORT"

# --- tunnel ---------------------------------------------------------------
# Started LAST and only if the gateway answers. A tunnel in front of a dead
# service returns ngrok's error page, which is a 200 — so a naive health
# check passes while every real delivery fails.
curl -sf -o /dev/null "http://127.0.0.1:$PORT/health" || {
  echo; echo "  Gateway is not healthy — refusing to expose it."; exit 1; }

if ! curl -sf -o /dev/null http://127.0.0.1:4040/api/tunnels 2>/dev/null; then
  chmod +x "$NGROK" 2>/dev/null   # the exec bit does not survive a sandbox reset
  [ -n "${NGROK_AUTHTOKEN:-}" ] && "$NGROK" config add-authtoken "$NGROK_AUTHTOKEN" >/dev/null 2>&1

  ARGS=(http "$PORT" --log=stdout)
  # --pooling-enabled, always.
  #
  # When this sandbox is reset the ngrok process is killed without closing its
  # session, so ngrok's edge still believes the reserved domain is online. The
  # next start then fails with ERR_NGROK_334 — while the URL keeps answering
  # 200 from ngrok's own error page, so a naive health check says "fine" and
  # every real delivery 502s. Pooling lets the new session join instead of
  # colliding, and the stale one ages out on its own.
  ARGS+=(--pooling-enabled)
  [ -n "${NGROK_DOMAIN:-}" ] && ARGS+=(--domain="$NGROK_DOMAIN")

  (nohup setsid "$NGROK" "${ARGS[@]}" > /tmp/ngrok.log 2>&1 &)
  sleep 8

  if ! curl -sf -o /dev/null http://127.0.0.1:4040/api/tunnels 2>/dev/null; then
    grep -oE 'ERR_NGROK_[0-9]+' /tmp/ngrok.log | tail -1 | while read -r code; do
      say "tunnel error" "$code"
    done
  fi
fi
URL=$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null \
  | python3 -c "import sys,json;print((json.load(sys.stdin).get('tunnels') or [{}])[0].get('public_url',''))" 2>/dev/null)
say "tunnel" "${URL:-FAILED}"

# --- prove it -------------------------------------------------------------
[ -n "$URL" ] || { echo; echo "  tunnel failed:"; tail -4 /tmp/ngrok.log; exit 1; }
echo
bash infra/scripts/verify-webhook.sh "$URL"
rc=$?
echo "  Webhook URL:  $URL/api/webhooks/paystack"
echo "  Inspector:    http://127.0.0.1:4040"
echo
exit $rc
