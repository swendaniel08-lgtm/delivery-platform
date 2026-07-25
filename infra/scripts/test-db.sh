#!/usr/bin/env bash
# Integration specs that need a real Postgres.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"
D="docker"; sudo -n true 2>/dev/null && D="sudo -n docker"
pgrep -x dockerd >/dev/null || { sudo -n /usr/sbin/dockerd >/tmp/dockerd.log 2>&1 & sleep 10; }

$D rm -f ledgerdb orderdb dispatchredis >/dev/null 2>&1 || true
$D run -d --name ledgerdb -p 55432:5432 -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=payment postgres:16-alpine >/dev/null
$D run -d --name orderdb  -p 55433:5432 -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=orders  postgres:16-alpine >/dev/null
$D run -d --name dispatchredis -p 56379:6379 redis:7-alpine >/dev/null
trap "$D rm -f ledgerdb orderdb dispatchredis >/dev/null 2>&1 || true" EXIT
for _ in $(seq 1 40); do $D exec ledgerdb pg_isready -U postgres -q 2>/dev/null && break; sleep 2; done
for _ in $(seq 1 40); do $D exec orderdb  pg_isready -U postgres -q 2>/dev/null && break; sleep 2; done

fail=0
for f in apps/svc-payment/test/ledger-service.spec.ts apps/svc-order/test/outbox-timers.spec.ts apps/svc-dispatch/test/dispatch-redis.spec.ts apps/e2e/test/order-flow.e2e.spec.ts apps/svc-payment/test/cod.spec.ts; do
  echo "── $f"
  out=$(npx tsx "$f" 2>&1)
  echo "$out" | grep -E "^# (tests|pass|fail)" | sed 's/^/   /'
  echo "$out" | grep -qE "^# fail 0$" || { echo "   FAILED"; echo "$out" | grep -A8 "not ok" | head -25; fail=1; }
done
bash infra/scripts/test-ledger.sh >/dev/null 2>&1 && echo "── ledger.spec (SQL): OK" || { echo "── ledger.spec (SQL): FAILED"; fail=1; }
[ $fail -eq 0 ] && echo "ALL DB SPECS PASSED" || echo "DB SPECS FAILED"
exit $fail
