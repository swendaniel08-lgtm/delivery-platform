#!/usr/bin/env bash
# Runs every unit spec. Exits non-zero if any fail.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"
fail=0
for f in libs/money/src/money.test.ts libs/auth/src/abilities.test.ts libs/maps/src/maps.test.ts apps/svc-identity/test/otp.spec.ts apps/svc-pricing/test/pricing.spec.ts apps/svc-identity/test/token.spec.ts apps/svc-order/test/cart.spec.ts apps/svc-payment/test/webhook.spec.ts apps/svc-payment/test/reconciliation.spec.ts; do
  echo "── $f"
  out=$(npx tsx "$f" 2>&1)
  echo "$out" | grep -E "^# (tests|pass|fail)" | sed 's/^/   /'
  echo "$out" | grep -qE "^# fail 0$" || { echo "   FAILED"; echo "$out" | grep -B2 -A8 "not ok" | head -30; fail=1; }
done
[ $fail -eq 0 ] && echo "ALL UNIT SPECS PASSED" || echo "UNIT SPECS FAILED"
exit $fail
