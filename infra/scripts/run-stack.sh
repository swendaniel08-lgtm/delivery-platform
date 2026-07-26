#!/usr/bin/env bash
# Start the Besonc backend locally.
#
#   bash infra/scripts/run-stack.sh          # start everything
#   bash infra/scripts/run-stack.sh stop     # stop everything
#   bash infra/scripts/run-stack.sh logs identity
#
# Reads .env if present, so this is where your real credentials go:
#   cp .env.example .env   &&   edit .env
#
# Deliberately plain processes, not Docker: the box this runs on has ~2GB of
# RAM and eleven containers will not fit. Compose is for CI and production.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"
export TMPDIR="${TMPDIR:-$HOME/.tmp}"; mkdir -p "$TMPDIR"

RUN_DIR="$ROOT/.run"
LOG_DIR="$RUN_DIR/logs"
mkdir -p "$LOG_DIR"

# Services in dependency order. Format: name:relative-main.ts:PORT_ENV:port
SERVICES=(
  "identity:apps/svc-identity/src/main.ts:SVC_IDENTITY_PORT:3001"
  "catalogue:apps/svc-catalogue/src/main.ts:SVC_CATALOGUE_PORT:3002"
  "order:apps/svc-order/src/main.ts:SVC_ORDER_PORT:3003"
  "pricing:apps/svc-pricing/src/main.ts:SVC_PRICING_PORT:3004"
  "dispatch:apps/svc-dispatch/src/main.ts:SVC_DISPATCH_PORT:3005"
  "tracking:apps/svc-tracking/src/main.ts:SVC_TRACKING_PORT:3006"
  "payment:apps/svc-payment/src/main.ts:SVC_PAYMENT_PORT:3007"
  "messaging:apps/svc-messaging/src/main.ts:SVC_MESSAGING_PORT:3008"
  "media:apps/svc-media/src/main.ts:SVC_MEDIA_PORT:3009"
  "admin:apps/svc-admin/src/main.ts:SVC_ADMIN_PORT:3010"
  "bff-customer:apps/bff-customer/src/main.ts:BFF_CUSTOMER_PORT:3101"
  "bff-vendor:apps/bff-vendor/src/main.ts:BFF_VENDOR_PORT:3102"
  "bff-rider:apps/bff-rider/src/main.ts:BFF_RIDER_PORT:3103"
  "bff-admin:apps/bff-admin/src/main.ts:BFF_ADMIN_PORT:3104"
  "gateway:apps/gateway/src/main.ts:PORT:3000"
)

load_env() {
  if [ -f "$ROOT/.env" ]; then
    echo "Loading credentials from .env"
    set -a; . "$ROOT/.env"; set +a
  else
    echo "No .env found — running with development defaults (stub SMS, no payments)."
    echo "  cp .env.example .env  and fill it in to use real credentials."
  fi
}

stop_all() {
  local stopped=0
  for f in "$RUN_DIR"/*.pid; do
    [ -e "$f" ] || continue
    local pid; pid=$(cat "$f")
    if kill -0 "$pid" 2>/dev/null; then
      # `npx tsx` spawns a CHILD that holds the port. Killing only the
      # wrapper leaves an orphan bound to it and the next start fails with
      # EADDRINUSE, so signal the whole process group.
      kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
      pkill -TERM -P "$pid" 2>/dev/null
      stopped=$((stopped+1))
    fi
    rm -f "$f"
  done
  # Anything still holding one of our ports is an orphan from an earlier run.
  for port in 3000 3001 3002 3003 3004 3005 3006 3007 3008 3009 3010 3101 3102 3103 3104; do
    local holder; holder=$(ss -ltnp 2>/dev/null | grep -oP "(?<=:)$port\\b.*pid=\\K[0-9]+" | head -1)
    [ -n "${holder:-}" ] && kill -TERM "$holder" 2>/dev/null
  done
  sleep 1
  echo "Stopped $stopped process(es)."
}

case "${1:-start}" in
  stop)
    stop_all
    exit 0
    ;;
  logs)
    svc="${2:-gateway}"
    tail -f "$LOG_DIR/$svc.log"
    exit 0
    ;;
  status)
    printf '%-14s %-8s %s\n' SERVICE PID HEALTH
    for entry in "${SERVICES[@]}"; do
      IFS=: read -r name _ _ port <<< "$entry"
      pidfile="$RUN_DIR/$name.pid"
      pid=$( [ -f "$pidfile" ] && cat "$pidfile" || echo '-' )
      health=$(curl -s -m 2 "http://127.0.0.1:$port/health" 2>/dev/null | head -c 40)
      printf '%-14s %-8s %s\n' "$name" "$pid" "${health:-unreachable}"
    done
    exit 0
    ;;
esac

load_env
stop_all
sleep 1

echo
for entry in "${SERVICES[@]}"; do
  IFS=: read -r name main portenv port <<< "$entry"

  # Each service owns its OWN schema. A single shared DATABASE_URL points
  # them all at the same database, and identity-svc then looks for `users`
  # in the orders schema and dies. Per-service override wins; otherwise
  # derive a database name from the shared base URL.
  svc_db_var="DATABASE_URL_$(echo "$name" | tr 'a-z-' 'A-Z_')"
  svc_db="${!svc_db_var:-}"
  if [ -z "$svc_db" ] && [ -n "${DATABASE_URL:-}" ]; then
    # Explicit, not derived: the service is called "order" but its database
    # is "orders". Guessing the name is how you get
    # `database "order" does not exist` at boot.
    case "$name" in
      order)      svc_db="${DATABASE_URL%/*}/orders" ;;
      identity|catalogue|payment|dispatch|tracking|messaging|media|admin)
                  svc_db="${DATABASE_URL%/*}/${name}" ;;
      *)          svc_db="" ;;   # BFFs and the gateway own no data
    esac
  fi

  # Point each service at its siblings on localhost.
  env "$portenv=$port" \
      DATABASE_URL="$svc_db" \
      SVC_IDENTITY_URL="${SVC_IDENTITY_URL:-http://127.0.0.1:3001}" \
      SVC_CATALOGUE_URL="${SVC_CATALOGUE_URL:-http://127.0.0.1:3002}" \
      SVC_ORDER_URL="${SVC_ORDER_URL:-http://127.0.0.1:3003}" \
      SVC_PRICING_URL="${SVC_PRICING_URL:-http://127.0.0.1:3004}" \
      SVC_DISPATCH_URL="${SVC_DISPATCH_URL:-http://127.0.0.1:3005}" \
      SVC_TRACKING_URL="${SVC_TRACKING_URL:-http://127.0.0.1:3006}" \
      SVC_PAYMENT_URL="${SVC_PAYMENT_URL:-http://127.0.0.1:3007}" \
      BFF_CUSTOMER_URL="${BFF_CUSTOMER_URL:-http://127.0.0.1:3101}" \
      BFF_VENDOR_URL="${BFF_VENDOR_URL:-http://127.0.0.1:3102}" \
      BFF_RIDER_URL="${BFF_RIDER_URL:-http://127.0.0.1:3103}" \
      BFF_ADMIN_URL="${BFF_ADMIN_URL:-http://127.0.0.1:3104}" \
      SVC_MESSAGING_URL="${SVC_MESSAGING_URL:-http://127.0.0.1:3008}" \
      SVC_MEDIA_URL="${SVC_MEDIA_URL:-http://127.0.0.1:3009}" \
      SVC_ADMIN_URL="${SVC_ADMIN_URL:-http://127.0.0.1:3010}" \
      setsid npx tsx "$main" > "$LOG_DIR/$name.log" 2>&1 &
  echo $! > "$RUN_DIR/$name.pid"
  printf '  started %-14s pid=%-7s port=%s\n' "$name" "$!" "$port"
  # tsx compiles TypeScript in-process and each one peaks around 150MB.
  # Launching fifteen simultaneously exhausts a small box and they all die
  # with heap errors that look like application bugs. Stagger them.
  sleep "${START_STAGGER_SECONDS:-2}"
done

echo
echo "Waiting for health checks…"
# tsx compiles TypeScript on the fly; ten services need more than a moment.
sleep "${HEALTH_WAIT_SECONDS:-20}"

failed=0
for entry in "${SERVICES[@]}"; do
  IFS=: read -r name _ _ port <<< "$entry"
  if curl -s -m 3 "http://127.0.0.1:$port/health" | grep -q '"status":"ok"'; then
    printf '  \033[32mOK\033[0m   %-14s http://127.0.0.1:%s\n' "$name" "$port"
  else
    # A configuration refusal (exit 78) is a deliberate answer, not a
    # crash — order-svc will not start without DATABASE_URL, by design.
    if grep -q "CONFIGURATION ERROR" "$LOG_DIR/$name.log" 2>/dev/null; then
      reason=$(grep -A1 "CONFIGURATION ERROR" "$LOG_DIR/$name.log" | tail -1 | sed 's/^ *//' | cut -c1-70)
      printf '  \033[33mSKIP\033[0m %-14s %s\n' "$name" "$reason"
    else
      printf '  \033[31mDOWN\033[0m %-14s (see %s)\n' "$name" "$LOG_DIR/$name.log"
      failed=$((failed+1))
    fi
  fi
done

echo
if [ $failed -eq 0 ]; then
  echo "Stack is up. Public API: http://127.0.0.1:3000"
  echo "  bash infra/scripts/run-stack.sh status"
  echo "  bash infra/scripts/run-stack.sh logs identity"
  echo "  bash infra/scripts/run-stack.sh stop"
else
  echo "$failed service(s) failed to start."
fi
exit $failed
