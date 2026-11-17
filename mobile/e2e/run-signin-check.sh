#!/usr/bin/env bash
# Diagnostic (branch staging-tester-check only): the real staging app on an Android emulator signs in
# through the "Staging test account" form twice — a fresh control account, then paul.tester with the
# STAGING_TESTER_PASSWORD secret typed by Maestro. Prints only the outcome and any error shown on
# screen; never the password (GitHub also masks the secret in logs).
set -uo pipefail
APK=e2e/app-release.apk; APP=app.courtbook.mobile.staging; OUT=e2e/out; mkdir -p "$OUT"
export PATH="$PATH:$HOME/.maestro/bin"
adb install -r "$APK" || exit 1
for s in window_animation_scale transition_animation_scale animator_duration_scale; do adb shell settings put global $s 0; done
adb shell monkey -p "$APP" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; sleep 60
status=0
check() { # label email password
  echo "::group::sign-in: $1"
  if (cd "$OUT" && maestro test -e "E2E_EMAIL=$2" -e "E2E_PASSWORD=$3" ../flows/_sign-in.yaml --format junit --output "signin-$1.xml" >/dev/null 2>&1); then
    echo "RESULT $1: signed in (Home shows 'Ready to play')"
  else
    adb shell uiautomator dump /sdcard/ui.xml >/dev/null && adb pull /sdcard/ui.xml "$OUT/ui-$1.xml" >/dev/null
    msg=$(python3 -c "import re; t=open('$OUT/ui-$1.xml').read(); print(' | '.join(x for x in re.findall(r'text=\"([^\"]+)\"', t) if re.search(r'sign-in failed|Invalid|error|Ready to play|Staging test account', x, re.I)))")
    echo "RESULT $1: NOT signed in; on screen: ${msg:-(no error text found)}"; status=1
  fi
  echo "::endgroup::"
}
check control "$E2E_EMAIL" "$E2E_PASSWORD"
check paul-tester "paul.tester@courtbook.test" "$E2E_TESTER_PASSWORD"
adb shell am force-stop "$APP"
exit $status
