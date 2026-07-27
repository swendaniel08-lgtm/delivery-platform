#!/usr/bin/env bash
# Expose the local gateway on a public HTTPS URL so Paystack can reach it.
#
# Paystack pushes webhooks from its own servers, so it cannot see localhost.
# A tunnel is the only way to exercise the real delivery path before the
# platform is deployed — and the webhook IS the source of truth for payment,
# so it is the one integration that must be proven end to end.
#
# Usage:
#   NGROK_AUTHTOKEN=... NGROK_DOMAIN=your-name.ngrok-free.dev \
#     bash infra/scripts/dev-tunnel.sh
#
# The reserved domain matters: without it ngrok issues a new random hostname
# on every restart and the Paystack dashboard has to be re-edited each time.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"

PORT="${GATEWAY_PORT:-3000}"
NGROK="${NGROK_BIN:-$HOME/ngrok}"

[ -x "$NGROK" ] || {
  echo "ngrok not found at $NGROK"
  echo "  curl -sL -o /tmp/ngrok.tgz https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz"
  echo "  tar xzf /tmp/ngrok.tgz -C \$HOME/"
  exit 1
}

[ -n "${NGROK_AUTHTOKEN:-}" ] && "$NGROK" config add-authtoken "$NGROK_AUTHTOKEN" >/dev/null

# The gateway must already be listening: a tunnel to nothing returns 502 and
# looks like a Paystack problem.
curl -sf -o /dev/null "http://127.0.0.1:$PORT/health" || {
  echo "No gateway on :$PORT. Start it first — `make run`, or:"
  echo "  set -a; . ./.env; set +a"
  echo "  PORT=$PORT npx tsx apps/gateway/src/main.ts"
  exit 1
}

ARGS=(http "$PORT" --log=stdout)
[ -n "${NGROK_DOMAIN:-}" ] && ARGS+=(--domain="$NGROK_DOMAIN")

(nohup setsid "$NGROK" "${ARGS[@]}" > /tmp/ngrok.log 2>&1 &)
sleep 8

URL=$(grep -oE 'url=https://[^ ]+' /tmp/ngrok.log | tail -1 | cut -d= -f2)
[ -z "$URL" ] && { echo "tunnel failed:"; tail -5 /tmp/ngrok.log; exit 1; }

cat <<EOF

  Tunnel up: $URL

  Paste into Paystack -> Settings -> API Keys & Webhooks:

    Test Webhook URL   $URL/api/webhooks/paystack
    Test Callback URL  (leave BLANK)

  The callback is deliberately empty. A browser redirect can be forged by
  the client; only the signed webhook is treated as payment truth.

  Watch deliveries:  http://127.0.0.1:4040
  Verify by hand:    bash infra/scripts/verify-webhook.sh $URL

EOF
