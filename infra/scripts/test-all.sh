#!/usr/bin/env bash
# Runs every unit spec. Exits non-zero if any fail.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"
fail=0
for f in libs/money/src/money.test.ts libs/auth/src/abilities.test.ts libs/maps/src/maps.test.ts apps/svc-identity/test/otp.spec.ts apps/svc-pricing/test/pricing.spec.ts apps/svc-identity/test/token.spec.ts apps/svc-order/test/cart.spec.ts apps/svc-payment/test/webhook.spec.ts apps/svc-payment/test/reconciliation.spec.ts apps/svc-order/test/state-machine.spec.ts apps/svc-dispatch/test/dispatch.spec.ts apps/svc-tracking/test/tracking.spec.ts apps/svc-messaging/test/messaging.spec.ts apps/svc-order/test/engines.spec.ts apps/gateway/test/gateway.spec.ts apps/bff-customer/test/bff.spec.ts apps/bff-vendor/test/bff.spec.ts apps/bff-admin/test/admin-media.spec.ts apps/svc-tracking/test/ws.spec.ts apps/svc-identity/test/identity-http.spec.ts apps/svc-catalogue/test/catalogue.spec.ts apps/svc-catalogue/test/catalogue-http.spec.ts apps/svc-dispatch/test/dispatch-http.spec.ts apps/svc-tracking/test/tracking-http.spec.ts apps/svc-payment/test/payment-http.spec.ts; do
  echo "── $f"
  out=$(npx tsx "$f" 2>&1)
  echo "$out" | grep -E "^# (tests|pass|fail)" | sed 's/^/   /'
  echo "$out" | grep -qE "^# fail 0$" || { echo "   FAILED"; echo "$out" | grep -B2 -A8 "not ok" | head -30; fail=1; }
done
[ $fail -eq 0 ] && echo "ALL UNIT SPECS PASSED" || echo "UNIT SPECS FAILED"
exit $fail
