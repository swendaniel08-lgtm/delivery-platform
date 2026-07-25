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
  # A package that depends on the Flutter SDK cannot run under plain
  # `dart test` — it needs the Flutter test binding.
  if grep -q "sdk: flutter" "$pkg/pubspec.yaml"; then
    out=$(cd "$pkg" && flutter pub get >/dev/null 2>&1 && flutter test --reporter compact 2>&1)
  else
    out=$(cd "$pkg" && dart pub get >/dev/null 2>&1 && dart test 2>&1)
  fi
  echo "$out" | tr '\r' '\n' | grep -E "All tests passed|Some tests failed" | tail -1 | sed 's/^/   /'
  echo "$out" | grep -q "All tests passed!" || { fail=1; echo "$out" | grep -A5 "Failing tests" | head -10; }
done
for app in "$ROOT"/mobile/apps/*/; do
  [ -d "$app/test" ] || continue
  name=$(basename "$app")
  files=$(find "$app/test" -name '*_test.dart' 2>/dev/null | wc -l)
  [ "$files" -eq 0 ] && continue
  echo "── app:$name"
  out=$(cd "$app" && flutter pub get >/dev/null 2>&1 && flutter test --reporter compact 2>&1)
  echo "$out" | tr '\r' '\n' | grep -E "All tests passed|Some tests failed" | tail -1 | sed 's/^/   /'
  echo "$out" | grep -q "All tests passed!" || { fail=1; echo "$out" | grep -E "\[E\]" | head -5; }
done

[ $fail -eq 0 ] && echo "ALL MOBILE SPECS PASSED" || echo "MOBILE SPECS FAILED"
exit $fail
