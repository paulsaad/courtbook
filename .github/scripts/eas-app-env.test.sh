#!/usr/bin/env bash
# Local test of eas-app-env.sh with a stand-in `eas` (no network, no Expo account): which EAS environment, channel and
# build profile each app gets, that the live and pilot apps never get crash reporting, and that a build is refused when
# the environment points at the wrong database.   bash .github/scripts/eas-app-env.test.sh
set -u
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
cat > "$work/bin/eas" <<'STUB'
#!/usr/bin/env bash
echo "eas $*" >> "$EAS_LOG"
if [ "$1" = env:pull ]; then
  envname=$2; out=$(echo "$@" | sed -nE 's/.*--path ([^ ]+).*/\1/p')
  var="URL_$envname"; echo "EXPO_PUBLIC_SUPABASE_URL=${!var:-}" > "$out"
fi
exit 0
STUB
chmod +x "$work/bin/eas"
LIVE=https://lgujfbwunokobjxlvpuf.supabase.co; STG=https://pwznauyioqykdwodwpvx.supabase.co
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "ok   $1"; else fail=$((fail+1)); echo "FAIL $1  [got: $2 | want: $3]"; fi; }
run() {   # app, URL for production/preview/development → exit code; GITHUB_ENV and log kept
  : > "$work/ghenv"; : > "$work/log"
  ( cd "$work" && PATH="$work/bin:$PATH" EAS_LOG="$work/log" GITHUB_ENV="$work/ghenv" URL_production="$2" URL_preview="$3" URL_development="$4" \
    STAGING_SUPABASE_URL="$STG" STAGING_ANON_KEY=k SENTRY_DSN=https://dsn.example/1 bash "$here/eas-app-env.sh" "$1" >/dev/null 2>&1 ); echo $?
}
rc=$(run pilot "$LIVE" "" ""); check "pilot: accepted with the live database" "$rc" 0
check "pilot: EAS environment production, channel pilot, profile pilot" "$(tr '\n' ' ' < "$work/ghenv")" "EAS_ENV=production CHANNEL=pilot PROFILE=pilot "
check "pilot: crash reporting removed, never set" "$(grep -c 'env:delete production --variable-name EXPO_PUBLIC_SENTRY_DSN' "$work/log")/$(grep -c 'EXPO_PUBLIC_SENTRY_DSN --value' "$work/log")" "1/0"
check "pilot: no staging settings written" "$(grep -c 'APP_VARIANT --value staging' "$work/log")" "0"
rc=$(run pilot "$STG" "" ""); check "pilot: refused when production points at the staging database" "$rc" 1
rc=$(run pilot "" "$LIVE" ""); check "pilot: refused when only the test-phone environment (preview) is set" "$rc" 1
rc=$(run live "" "$LIVE" ""); check "live: unchanged (preview environment, live database)" "$rc/$(tr '\n' ' ' < "$work/ghenv")" "0/EAS_ENV=preview CHANNEL=preview PROFILE=preview "
check "live: crash reporting removed" "$(grep -c 'env:delete preview --variable-name EXPO_PUBLIC_SENTRY_DSN' "$work/log")" "1"
rc=$(run staging "" "" "$STG"); check "staging: unchanged (development environment, staging database, crash reporting on)" "$rc/$(tr '\n' ' ' < "$work/ghenv")/$(grep -c 'EXPO_PUBLIC_SENTRY_DSN --value' "$work/log")" "0/EAS_ENV=development CHANNEL=staging PROFILE=staging APP_VARIANT=staging /1"
rc=$(run store "$LIVE" "$LIVE" ""); check "an unknown app is refused" "$rc" 1
# the profile the pilot uses exists, builds an app bundle for the store, on channel pilot, never the APK test profiles
prof=$(node -e "const b=require('$here/../../mobile/eas.json').build.pilot; console.log([b.distribution,b.android.buildType,b.channel,b.environment,b.autoIncrement].join(' '))")
check "eas.json pilot profile: store app bundle, channel pilot, environment production, version code auto-increment" "$prof" "store app-bundle pilot production true"
echo "eas-app-env: $pass ok, $fail failed"
[ "$fail" -eq 0 ]
