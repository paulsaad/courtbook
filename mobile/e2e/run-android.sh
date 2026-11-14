#!/usr/bin/env bash
# Runs inside the emulator job (mobile/ is the working directory). Installs the test build, runs the
# Maestro flows against staging, then screenshots every main screen at several display and text
# sizes, and audits each screen for TalkBack. Everything lands in e2e/out/ for the artifact.
set -uo pipefail
OUT=e2e/out; mkdir -p "$OUT/shots/sizes"
APK=android/app/build/outputs/apk/release/app-release.apk
APP=app.courtbook.mobile.staging
export PATH="$PATH:$HOME/.maestro/bin"
envs=(-e "E2E_EMAIL=$E2E_EMAIL" -e "E2E_PASSWORD=$E2E_PASSWORD" -e "E2E_CLUB=$E2E_CLUB" -e "E2E_DATE=$E2E_DATE")
status=0

adb install -r "$APK" || exit 1
adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb shell settings put global animator_duration_scale 0

# 0. Does it start? First launch, then what is on screen and anything the app logged.
adb logcat -c
adb shell monkey -p "$APP" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
sleep 45
echo "::group::first launch"
adb shell uiautomator dump /sdcard/ui.xml >/dev/null && adb pull /sdcard/ui.xml "$OUT/first.xml" >/dev/null
python3 -c "import re,sys; t=open('$OUT/first.xml').read(); print('on screen:', [x for x in re.findall(r'(?:text|content-desc)=\"([^\"]+)\"', t) if x][:40])"
adb logcat -d -v brief ReactNativeJS:V ReactNative:W AndroidRuntime:E ActivityManager:W '*:F' '*:S' | tail -150 | tee "$OUT/logcat-first.txt"
echo "::endgroup::"

# 1. Behaviour: book and cancel, unresolved recovery, offline.
for f in 01-book-and-cancel 02-answer-lost-recovery 03-offline; do
  echo "::group::flow $f"
  if (cd "$OUT" && maestro test "${envs[@]}" "../flows/$f.yaml" --format junit --output "$f.xml"); then
    echo "flow $f: PASS"
  else
    echo "::error::flow $f failed"; status=1
  fi
  echo "::endgroup::"
done

# 2. Sizes: small phone (360 dp), large phone (412 dp); text at 100%, 130%, and the app's maximum.
density=$(adb shell wm density | tr -dc '0-9\n' | tail -1)
for cfg in "1080x2400 420 412dp" "1080x1920 480 360dp"; do
  set -- $cfg; size=$1; dpi=$2; name=$3
  adb shell wm size "$size"; adb shell wm density "$dpi"
  for fs in 1.0 1.3 1.6; do
    adb shell settings put system font_scale "$fs"
    adb shell am force-stop "$APP"
    (cd "$OUT" && maestro test "${envs[@]}" -e "SUFFIX=${name}-text${fs}" ../flows/screens.yaml) || { echo "::warning::screens $name text $fs incomplete"; }
  done
  adb shell settings put system font_scale 1.0
  # 3. TalkBack audit of each screen at this size, normal text.
  for route in "" "courts" "bookings" "profile" "club/${E2E_CLUB}?date=${E2E_DATE}" "sign-in"; do
    adb shell am start -W -a android.intent.action.VIEW -d "courtbook-staging://${route}" "$APP" >/dev/null
    sleep 4
    adb shell uiautomator dump /sdcard/ui.xml >/dev/null && adb pull /sdcard/ui.xml "$OUT/ui.xml" >/dev/null
    python3 e2e/a11y_audit.py "$OUT/ui.xml" "${name}:/${route%%\?*}" "$dpi" | tee -a "$OUT/a11y.txt" || status=1
  done
done
adb shell wm size reset; adb shell wm density reset
echo "::group::logcat (app errors)"
adb logcat -d -v brief ReactNativeJS:V AndroidRuntime:E '*:F' '*:S' | tail -200 | tee "$OUT/logcat.txt"
echo "::endgroup::"
exit $status
