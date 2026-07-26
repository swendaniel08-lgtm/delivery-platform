#!/usr/bin/env bash
# Full-platform integration test.
#
# Boots the real gateway, identity, catalogue, pricing, order and customer
# BFF as SEPARATE PROCESSES against a real Postgres, then drives a customer
# from sign-up to a settled order.
#
# This is the only test that would have caught the gateway prefix bug, the
# BFF contract mismatches, or idempotency being silently unenforced. Every
# one of those passed the unit suite.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"
export TMPDIR="${TMPDIR:-$HOME/.tmp}"; mkdir -p "$TMPDIR"

D="docker"; sudo -n true 2>/dev/null && D="sudo -n docker"
pgrep -x dockerd >/dev/null || { sudo -n /usr/sbin/dockerd >/tmp/dockerd.log 2>&1 & sleep 12; }

PG_NAME=besonc-e2e-pg
PG_PORT=55450

cleanup() {
  # Kill anything still bound to the test ports. tsx spawns a child, so the
  # spec's SIGTERM can leave an orphan holding the port and the next run
  # fails with EADDRINUSE that looks like a code bug.
  for port in 4801 4802 4803 4804 4805 4806 4807 4808 4900 4901 4902 4903; do
    pids=$(ss -ltnp 2>/dev/null | grep -oP "(?<=:)${port}\b.*pid=\K[0-9]+" || true)
    [ -n "${pids:-}" ] && kill -TERM $pids 2>/dev/null
  done
  $D rm -f "$PG_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cleanup
echo "Starting PostGIS on :$PG_PORT …"
# PostGIS, not plain postgres: several migrations need the extension.
$D run -d --name "$PG_NAME" -p "$PG_PORT:5432" \
  -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=postgres \
  postgis/postgis:16-3.4-alpine >/dev/null

# pg_isready inside the container goes green BEFORE the published port is
# accepting TCP from the host, so waiting on it alone gives
# "Connection terminated unexpectedly" the moment the suite connects.
# Probe from the OUTSIDE, the way the tests will.
ready=0
for _ in $(seq 1 90); do
  if $D exec "$PG_NAME" pg_isready -U postgres -q 2>/dev/null; then
    if node -e "
      const net = require('net');
      const s = net.connect($PG_PORT, '127.0.0.1');
      s.on('connect', () => { s.end(); process.exit(0); });
      s.on('error', () => process.exit(1));
      setTimeout(() => process.exit(1), 1500);
    " 2>/dev/null; then ready=1; break; fi
  fi
  sleep 1
done
[ "$ready" = "1" ] || { echo "Postgres never accepted connections on :$PG_PORT"; exit 1; }
# One more beat: the first connection after startup can still be refused
# while Postgres finishes its own initialisation.
sleep 2

# Lanes.
#
# MEASURED: each tsx service holds ~230MB resident, and that is the esbuild
# compiler plus the Node binary — NOT V8 old-space, so --max-old-space-size
# does not shrink it (capping to 160MB merely starves the compiler until it
# dies mid-boot). Twelve services is ~2.7GB; a small CI box or this sandbox
# has ~2GB, and no amount of staggering helps because they all stay resident
# once booted. The OOM killer then takes one AFTER it reported healthy, which
# surfaces as unrelated 503s in a later suite.
#
# So each lane boots only the services it exercises and they run one after
# another. Coverage is identical — all 34 assertions still run — at a peak of
# about six services instead of twelve.
#
# E2E_LANES=all runs everything in ONE process, which is correct and faster
# on a machine with real memory. That is what CI should use.
LANES="${E2E_LANES:-core vendor rider}"

total_pass=0
total_fail=0
total_notok=0
: > "$TMPDIR/platform-e2e.log"

for lane in $LANES; do
  echo "── lane: $lane"
  laneopt=""
  [ "$lane" != "all" ] && laneopt="$lane"

  E2E_LANE="$laneopt" PLATFORM_PG_HOST=127.0.0.1 PLATFORM_PG_PORT="$PG_PORT" \
    npx tsx apps/e2e/test/platform.e2e.spec.ts 2>&1 \
    | tee -a "$TMPDIR/platform-e2e.log" \
    | grep -E "^(# (tests|pass|fail)|not ok|# lane)" | sed 's/^/   /'

  # Per-lane tallies from the tail of what this lane just appended.
  p=$(grep -oP "^# pass \K[0-9]+" "$TMPDIR/platform-e2e.log" | tail -1)
  f=$(grep -oP "^# fail \K[0-9]+" "$TMPDIR/platform-e2e.log" | tail -1)
  total_pass=$((total_pass + ${p:-0}))
  total_fail=$((total_fail + ${f:-1}))

  # Free the ports before the next lane, or it starts against half-dead
  # processes and every failure looks like a code bug.
  for port in 4801 4802 4803 4804 4805 4806 4807 4808 4900 4901 4902 4903; do
    pids=$(ss -ltnp 2>/dev/null | grep -oP "(?<=:)${port}\b.*pid=\K[0-9]+" || true)
    [ -n "${pids:-}" ] && kill -TERM $pids 2>/dev/null
  done
  sleep 3
done

total_notok=$(grep -c "^not ok" "$TMPDIR/platform-e2e.log" || true)

# "# fail 0" alone is NOT enough: a suite whose before() hook throws reports
# `# pass 0  # fail 0` and would sail through. Demand real passes and no
# "not ok" lines anywhere.
if [ "$total_fail" -eq 0 ] && [ "$total_pass" -gt 0 ] && [ "${total_notok:-1}" -eq 0 ]; then
  echo "PLATFORM E2E PASSED ($total_pass assertions across: $LANES)"
  exit 0
fi
echo "PLATFORM E2E FAILED (pass=$total_pass fail=$total_fail not-ok=${total_notok:-?})"
echo "Full log: $TMPDIR/platform-e2e.log"
grep -A6 "not ok" "$TMPDIR/platform-e2e.log" | head -30
exit 1
