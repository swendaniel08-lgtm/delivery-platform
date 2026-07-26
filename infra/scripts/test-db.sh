#!/usr/bin/env bash
# Integration specs that need a real Postgres.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"
D="docker"; sudo -n true 2>/dev/null && D="sudo -n docker"
pgrep -x dockerd >/dev/null || { sudo -n /usr/sbin/dockerd >/tmp/dockerd.log 2>&1 & sleep 10; }

$D rm -f ledgerdb orderdb dispatchredis admindb mq schemadb mediaminio >/dev/null 2>&1 || true
$D run -d --name ledgerdb -p 55432:5432 -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=payment postgres:16-alpine >/dev/null
$D run -d --name orderdb  -p 55433:5432 -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=orders  postgres:16-alpine >/dev/null
$D run -d --name dispatchredis -p 56379:6379 redis:7-alpine >/dev/null
$D run -d --name admindb -p 55434:5432 -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=admin postgres:16-alpine >/dev/null
# PostGIS needed by dispatch/tracking schemas
$D run -d --name schemadb -p 55440:5432 -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=t postgis/postgis:16-3.4 >/dev/null
# RabbitMQ: this image's baked-in erlang cookie has permissions Erlang rejects
# under our docker setup, so write a fresh one before starting the server.
$D run -d --name mq -p 5673:5672 -u 0 --entrypoint sh rabbitmq:3.13-alpine \
  -c 'mkdir -p /var/lib/rabbitmq && echo besonc > /var/lib/rabbitmq/.erlang.cookie && chmod 400 /var/lib/rabbitmq/.erlang.cookie && chown rabbitmq:rabbitmq /var/lib/rabbitmq/.erlang.cookie && exec docker-entrypoint.sh rabbitmq-server' >/dev/null
# Real S3. The presigned-URL adapter cannot be proven by unit tests alone:
# a path-style mistake or an unsigned header fails as HTTP 403, which is
# indistinguishable from bad credentials until a real server judges it.
$D run -d --name mediaminio -p 59000:9000 \
  -e MINIO_ROOT_USER=besonc -e MINIO_ROOT_PASSWORD=besonc_dev_secret \
  minio/minio:latest server /data >/dev/null
trap "$D rm -f ledgerdb orderdb dispatchredis admindb mq schemadb mediaminio mediaminio >/dev/null 2>&1 || true" EXIT
for _ in $(seq 1 40); do $D exec ledgerdb pg_isready -U postgres -q 2>/dev/null && break; sleep 2; done
for _ in $(seq 1 40); do $D exec orderdb  pg_isready -U postgres -q 2>/dev/null && break; sleep 2; done
for _ in $(seq 1 40); do $D exec admindb  pg_isready -U postgres -q 2>/dev/null && break; sleep 2; done
for _ in $(seq 1 40); do $D exec schemadb pg_isready -U postgres -q 2>/dev/null && break; sleep 2; done
for _ in $(seq 1 50); do $D exec mq rabbitmq-diagnostics -q ping >/dev/null 2>&1 && break; sleep 3; done
for _ in $(seq 1 30); do curl -sf http://127.0.0.1:59000/minio/health/live >/dev/null && break; sleep 1; done

fail=0
for f in apps/svc-payment/test/ledger-service.spec.ts apps/svc-order/test/outbox-timers.spec.ts apps/svc-dispatch/test/dispatch-redis.spec.ts apps/e2e/test/order-flow.e2e.spec.ts apps/svc-payment/test/cod.spec.ts apps/svc-admin/test/audit.spec.ts apps/e2e/test/outbox-relay.e2e.spec.ts apps/e2e/test/service-bootstrap.e2e.spec.ts apps/e2e/test/schemas.e2e.spec.ts apps/svc-media/test/s3.integration.spec.ts apps/svc-messaging/test/dedupe-redis.spec.ts; do
  echo "── $f"
  out=$(npx tsx "$f" 2>&1); code=$?
  echo "$out" | grep -E "^# (tests|pass|fail)" | sed 's/^/   /'
  # BOTH conditions. The TAP summary alone misses a crash after the last
  # test (an unclosed pool, an uncaught rejection in teardown); the exit code
  # alone misses nothing but says nothing useful. Together they cannot lie.
  { [ $code -eq 0 ] && echo "$out" | grep -qE "^# fail 0$"; } || { echo "   FAILED (exit $code)"; echo "$out" | grep -A8 "not ok" | head -25; fail=1; }
done
bash infra/scripts/test-ledger.sh >/dev/null 2>&1 && echo "── ledger.spec (SQL): OK" || { echo "── ledger.spec (SQL): FAILED"; fail=1; }
[ $fail -eq 0 ] && echo "ALL DB SPECS PASSED" || echo "DB SPECS FAILED"
exit $fail
