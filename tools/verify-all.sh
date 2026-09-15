#!/usr/bin/env bash
# Everything that says whether Bluesheet is whole, in one command.
#   ./tools/verify-all.sh [--quick]
# --quick skips the browser and slicing passes, which need Chrome and OrcaSlicer.
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
QUICK=0; [ "$1" = "--quick" ] && QUICK=1
fail=0
line() { printf '\n\033[1m── %s\033[0m\n' "$1"; }

line "catalogue"
node tools/sync-registry.mjs || true

line "node suites"
node tests/run.mjs 2>&1 | tail -6 | tee /tmp/bluesheet-verify-node.txt
grep -q "RESULT: PASS" /tmp/bluesheet-verify-node.txt || fail=1

line "python suites"
for t in tests/test_server.py tests/security_probe.py tests/slice_smoke.py tests/test_made.py; do
  [ -f "$t" ] || continue
  out=$(timeout 400 python3 "$t" 2>&1 | tail -2)
  printf '%-28s %s\n' "$(basename "$t")" "$(echo "$out" | tr '\n' ' ')"
  echo "$out" | grep -qE "RESULT: PASS|SECURITY OK|SLICE OK|^OK" || fail=1
done

if [ "$QUICK" = "0" ]; then
  line "browser"
  timeout 400 node tests/browser.test.mjs 2>&1 | tail -4 || fail=1
fi

printf '\n\033[1mVERIFY: %s\033[0m\n' "$([ $fail = 0 ] && echo PASS || echo FAIL)"
exit $fail
