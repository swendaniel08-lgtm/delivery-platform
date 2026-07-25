#!/usr/bin/env bash
# ledger.spec runner — spins a throwaway Postgres, applies the migration, runs the spec.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
C=besonc-ledger-test
DOCKER="docker"; sudo -n true 2>/dev/null && DOCKER="sudo -n docker"

pgrep -x dockerd >/dev/null || { sudo -n /usr/sbin/dockerd >/tmp/dockerd.log 2>&1 & sleep 10; }
$DOCKER rm -f $C >/dev/null 2>&1 || true
$DOCKER run -d --name $C -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=payment postgres:16-alpine >/dev/null
trap "$DOCKER rm -f $C >/dev/null 2>&1 || true" EXIT

for _ in $(seq 1 40); do $DOCKER exec $C pg_isready -U postgres -q 2>/dev/null && break; sleep 2; done

$DOCKER exec -i $C psql -U postgres -d payment -q -v ON_ERROR_STOP=1 < "$ROOT/apps/svc-payment/migrations/001_ledger.sql"
out=$($DOCKER exec -i $C psql -U postgres -d payment -q -v ON_ERROR_STOP=1 < "$ROOT/apps/svc-payment/test/ledger.spec.sql" 2>&1)
echo "$out" | grep -E "PASS|FAIL|ALL TESTS" || true
echo "$out" | grep -q "ALL TESTS PASSED" || { echo "ledger.spec FAILED"; exit 1; }
echo "ledger.spec: OK"
