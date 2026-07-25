#!/usr/bin/env bash
# Dart/Flutter specs. Requires /opt/flutter (see bootstrap.sh).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PATH=/opt/flutter/bin:$PATH
export TMPDIR="${TMPDIR:-$HOME/.tmp}"; mkdir -p "$TMPDIR"

command -v dart >/dev/null || { echo "Flutter SDK missing - run bootstrap.sh"; exit 1; }

fail=0
for pkg in "$ROOT"/mobile/packages/*/; do
  [ -d "$pkg/test" ] || continue
  name=$(basename "$pkg")
  files=$(find "$pkg/test" -name '*_test.dart' 2>/dev/null | wc -l)
  [ "$files" -eq 0 ] && continue
  echo "── $name"
  out=$(cd "$pkg" && dart pub get >/dev/null 2>&1 && dart test 2>&1)
  echo "$out" | tail -1 | sed 's/^/   /'
  echo "$out" | grep -q "All tests passed!" || { fail=1; echo "$out" | grep -A5 "Failing tests" | head -10; }
done
[ $fail -eq 0 ] && echo "ALL MOBILE SPECS PASSED" || echo "MOBILE SPECS FAILED"
exit $fail
