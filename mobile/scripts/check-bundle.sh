#!/usr/bin/env bash
# Runs the exact JavaScript bundling step an EAS release build runs
# (`expo export:embed --eager --dev false`), for iOS and Android, on a copy of mobile/ ALONE —
# nothing from the rest of the repository — because that is what an EAS build receives when its
# project root is mobile/. If this passes, the bundling phase of an EAS build will not fail.
# Run from mobile/. Uses the committed files only (git archive), never the working tree.
set -euo pipefail
ref="${1:-HEAD}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git -C .. archive "$ref" mobile | tar -x -C "$work"
cd "$work/mobile"
echo "Bundling $ref from an isolated copy of mobile/ at $work/mobile"
npm ci --no-audit --no-fund
for platform in ios android; do
  echo "--- $platform: expo export:embed --eager --platform $platform --dev false"
  CI=1 EXPO_OFFLINE=1 npx expo export:embed --eager --platform "$platform" --dev false \
    --entry-file node_modules/expo-router/entry.js \
    --bundle-output "$work/out-$platform/main.bundle" --assets-dest "$work/out-$platform"
  test -s "$work/out-$platform/main.bundle"
done
echo "production bundling passed for ios and android"
