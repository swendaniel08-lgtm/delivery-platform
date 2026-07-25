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
  "pricing:apps/svc-pricing/src/main.ts:SVC_PRICING_PORT:3004"
  "dispatch:apps/svc-dispatch/src/main.ts:SVC_DISPATCH_PORT:3005"
  "tracking:apps/svc-tracking/src/main.ts:SVC_TRACKING_PORT:3006"
  "payment:apps/svc-payment/src/main.ts:SVC_PAYMENT_PORT:3007"
  "bff-customer:apps/bff-customer/src/main.ts:BFF_CUSTOMER_PORT:3101"
  "bff-vendor:apps/bff-vendor/src/main.ts:BFF_VENDOR_PORT:3102"
  "bff-rider:apps/bff-rider/src/main.ts:BFF_RIDER_PORT:3103"
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
  for port in 3000 3001 3002 3004 3005 3006 3007 3101 3102 3103; do
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
  # Point each service at its siblings on localhost.
  env "$portenv=$port" \
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
      setsid npx tsx "$main" > "$LOG_DIR/$name.log" 2>&1 &
  echo $! > "$RUN_DIR/$name.pid"
  printf '  started %-14s pid=%-7s port=%s\n' "$name" "$!" "$port"
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
    printf '  \033[31mDOWN\033[0m %-14s (see %s)\n' "$name" "$LOG_DIR/$name.log"
    failed=$((failed+1))
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
