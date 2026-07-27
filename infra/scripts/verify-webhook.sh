#!/usr/bin/env bash
# Prove a webhook endpoint is reachable AND that it rejects forgeries.
#
# Reachability alone is not the interesting part. An endpoint that accepts
# everything is worse than one that is down: a forged charge.success is a free
# order. So this sends four requests and all four verdicts must hold.
#
# Usage: bash infra/scripts/verify-webhook.sh https://your-host [PAYSTACK_SECRET_KEY]
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"

BASE="${1:-http://127.0.0.1:3000}"
SECRET="${2:-${PAYSTACK_SECRET_KEY:-}}"
[ -n "$SECRET" ] || { echo "need PAYSTACK_SECRET_KEY"; exit 1; }

URL="$BASE/api/webhooks/paystack"
REF="verify-$(date +%s)"
BODY="{\"event\":\"charge.success\",\"data\":{\"reference\":\"$REF\",\"amount\":8150,\"currency\":\"GHS\",\"status\":\"success\",\"channel\":\"mobile_money\"}}"

# Signed in python to avoid any shell mangling of the exact bytes: the
# signature covers the RAW body, so one stray newline breaks it and looks
# like a credentials fault.
SIG=$(SECRET="$SECRET" BODY="$BODY" python3 -c '
import hmac,hashlib,os
print(hmac.new(os.environ["SECRET"].encode(), os.environ["BODY"].encode(), hashlib.sha512).hexdigest())')

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo
echo "  $URL"
echo

A=$(code -X POST "$URL" -H 'content-type: application/json' -H "x-paystack-signature: $SIG" -d "$BODY")
B=$(code -X POST "$URL" -H 'content-type: application/json' -H "x-paystack-signature: $SIG" -d "$BODY")
C=$(code -X POST "$URL" -H 'content-type: application/json' -H "x-paystack-signature: deadbeef" -d "$BODY")
D=$(code -X POST "$URL" -H 'content-type: application/json' -d "$BODY")

pass=0
chk() { # label actual expected
  if [ "$2" = "$3" ]; then printf '  \033[32mok\033[0m   %-34s %s\n' "$1" "$2"
  else printf '  \033[31mFAIL\033[0m %-34s %s (want %s)\n' "$1" "$2" "$3"; pass=1; fi
}
chk "genuine signature accepted"  "$A" "201"
chk "replay reported as duplicate" "$B" "201"
chk "forged signature rejected"    "$C" "401"
chk "missing signature rejected"   "$D" "401"

echo
if [ $pass -eq 0 ]; then
  echo "  Webhook endpoint is correct. Safe to paste into Paystack."
else
  echo "  Do NOT point Paystack at this endpoint yet."
  echo "  A 502 usually means the gateway is not running behind the tunnel."
  echo "  A 201 on a forged signature means the raw body is being re-serialised"
  echo "  somewhere in the chain — the signature covers bytes, not JSON."
fi
exit $pass
