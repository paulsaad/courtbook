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
    adb shell input swipe 540 900 540 1700 300; sleep 1   # scroll up a little, towards the top of the form
    adb shell uiautomator dump /sdcard/ui.xml >/dev/null && adb pull /sdcard/ui.xml "$OUT/ui-$1.xml" >/dev/null
    msg=$(python3 -c "import re; t=open('$OUT/ui-$1.xml').read(); print(' | '.join(x for x in re.findall(r'text=\"([^\"]+)\"', t) if re.search(r'sign-in failed|Invalid|error|Ready to play|Staging test account', x, re.I)))")
    echo "RESULT $1: NOT signed in; on screen: ${msg:-(no error text found)}"; status=1
  fi
  echo "::endgroup::"
}
check control "$E2E_EMAIL" "$E2E_PASSWORD"
check paul-tester "paul.tester@courtbook.test" "$E2E_TESTER_PASSWORD"
paste() { # label first_wrong
  echo "::group::paste: $1"
  adb logcat -c
  if (cd "$OUT" && maestro test -e "E2E_EMAIL=paul.tester@courtbook.test" -e "E2E_PASSWORD=$E2E_TESTER_PASSWORD" -e "FIRST_WRONG=$2" ../flows/_diag-paste.yaml --format junit --output "paste-$1.xml" > "paste-$1.log" 2>&1); then
    echo "RESULT $1: signed in (Home shows 'Ready to play')"
    adb logcat -d -v raw ReactNativeJS:V '*:S' | grep -c "\[diag\]" | sed 's/^/DIAG attempts logged: /'
  else
    adb shell input swipe 540 900 540 1700 300; sleep 1   # scroll up a little, towards the top of the form
    adb shell uiautomator dump /sdcard/ui.xml >/dev/null && adb pull /sdcard/ui.xml "$OUT/ui-$1.xml" >/dev/null
    msg=$(python3 -c "import re; t=open('$OUT/ui-$1.xml').read(); print(' | '.join(x for x in re.findall(r'text=\"([^\"]+)\"', t) if re.search(r'sign-in failed|Invalid|error|Ready to play', x, re.I) and '[diag]' not in x))")
    adb logcat -d -v raw ReactNativeJS:V '*:S' > "$OUT/logcat-$1.txt"
    python3 - "$OUT/logcat-$1.txt" <<'PY'
import os, re, sys
secret = os.environ["E2E_TESTER_PASSWORD"]
h = 0x811c9dc5
for ch in secret:
    h ^= ord(ch); h = (h * 0x01000193) & 0xffffffff
want = format(h, "08x")
lines = [m for m in re.finditer(r'\[diag\] email sent: "(.*?)" \((\d+)\); password sent: (\d+) chars; fp ([0-9a-f]{8})', open(sys.argv[1]).read())]
if not lines: print("DIAG: no attempt logged")
for n, m in enumerate(lines, 1):
    print(f"DIAG attempt {n}: email sent {m.group(1)!r}; password sent {m.group(3)} chars (secret {len(secret)}); equals the secret: {'YES' if m.group(4) == want else 'NO'}")
PY
    step=$(sed 's/\x1b\[[0-9;]*m//g' "$OUT/paste-$1.log" | grep -v -i "input text" | grep -E "FAILED|❌|Element not found|Assertion|not found" | head -3 | tr '\n' ' ')
    echo "RESULT $1: NOT signed in; on screen: ${msg:-(no error text)}; maestro: ${step:-?}"
  fi
  sed 's/\x1b\[[0-9;]*m//g' "$OUT/paste-$1.log" | grep -v -i "input text" | grep -E "✅|❌|COMPLETED|FAILED|SKIPPED" | tail -30
  echo "::endgroup::"
}
paste paste-clean no
paste paste-after-failed-attempt yes
adb shell am force-stop "$APP"
exit $status
