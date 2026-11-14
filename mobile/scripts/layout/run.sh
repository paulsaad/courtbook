#!/usr/bin/env bash
# Layout checks for the booking screens at phone sizes and larger text, in a browser build of the
# app with faked Supabase answers. Approximates a phone (no Dynamic Type, web fonts); the phone test
# is still the real one. Needs Google Chrome. Leaves package.json and the app untouched.
#   bash mobile/scripts/layout/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
PHOTO=${PHOTO:-$PWD/assets/icon.png}
OUT=${WEBOUT:-/tmp/courtbook-webout}; TOOLS=${TOOLS:-/tmp/courtbook-layout-tools}
npm i --no-save react-native-web@0.21 @expo/metro-runtime@~58 >/dev/null
# SecureStore has no web implementation; a throwaway localStorage stand-in for this build only
cat > lib/secureStorage.web.ts <<'TS'
export const ChunkedSecureStore = {
  getItem: async (k: string) => globalThis.localStorage?.getItem(k) ?? null,
  setItem: async (k: string, v: string) => { globalThis.localStorage?.setItem(k, v); },
  removeItem: async (k: string) => { globalThis.localStorage?.removeItem(k); },
};
TS
trap 'rm -f lib/secureStorage.web.ts' EXIT
rm -rf "$OUT"
EXPO_PUBLIC_SUPABASE_URL=https://fakeproj.supabase.co EXPO_PUBLIC_SUPABASE_ANON_KEY=anon-test-key \
  npx expo export --platform web --output-dir "$OUT" >/dev/null
mkdir -p "$TOOLS"; [ -d "$TOOLS/node_modules/playwright-core" ] || (cd "$TOOLS" && npm init -y >/dev/null && npm i playwright-core@1 >/dev/null)
cp scripts/layout/*.mjs "$TOOLS/"
(cd "$TOOLS" && WEBOUT="$OUT" node check-panel.mjs && WEBOUT="$OUT" node check-ticket.mjs && WEBOUT="$OUT" PHOTO="$PHOTO" node check-info.mjs && WEBOUT="$OUT" node check-pending.mjs)
echo "Remove the web-only packages again with: npm ci"
