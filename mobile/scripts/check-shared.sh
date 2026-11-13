#!/usr/bin/env bash
# Fails if any file in mobile/shared/ differs from the web app's src/lib/ file of the same name.
# Run from mobile/. Needs the full repository (CI has it).
set -euo pipefail
status=0
for f in shared/*.ts; do
  src="../src/lib/$(basename "$f")"
  if [ ! -f "$src" ]; then echo "MISSING SOURCE: $src for $f"; status=1; continue; fi
  if ! cmp -s "$f" "$src"; then echo "DIFFERS: $f vs $src — copy src/lib over it"; diff -u "$src" "$f" | head -20; status=1; fi
done
[ $status -eq 0 ] && echo "shared copies match src/lib"
exit $status
