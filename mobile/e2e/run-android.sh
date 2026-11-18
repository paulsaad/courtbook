#!/usr/bin/env bash
# Runs inside the emulator job (mobile/ is the working directory). Installs the test build, runs the
# Maestro flows against staging, then screenshots every main screen at several display and text
# sizes, and audits each screen for TalkBack. Everything lands in e2e/out/ for the artifact.
set -uo pipefail
OUT=e2e/out; mkdir -p "$OUT/shots/sizes"
APK=e2e/app-release.apk
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
sleep 60
echo "::group::first launch"
adb shell uiautomator dump /sdcard/ui.xml >/dev/null && adb pull /sdcard/ui.xml "$OUT/first.xml" >/dev/null
python3 -c "import re,sys; t=open('$OUT/first.xml').read(); print('on screen:', [x for x in re.findall(r'(?:text|content-desc)=\"([^\"]+)\"', t) if x][:40])"
adb logcat -d -v brief ReactNativeJS:V ReactNative:W AndroidRuntime:E ActivityManager:W '*:F' '*:S' | tail -150 | tee "$OUT/logcat-first.txt"
echo "::endgroup::"

# 1. Behaviour: book and cancel, unresolved recovery, offline.
for f in 01-book-and-cancel 02-answer-lost-recovery 03-offline 04-link-then-back 05-crash-report; do
  echo "::group::flow $f"
  if (cd "$OUT" && maestro test "${envs[@]}" "../flows/$f.yaml" --format junit --output "$f.xml"); then
    echo "flow $f: PASS"
  else
    echo "::error::flow $f failed"; status=1
    # What was on screen when it failed (artifacts can't always be fetched).
    adb shell uiautomator dump /sdcard/ui.xml >/dev/null && adb pull /sdcard/ui.xml "$OUT/fail-$f.xml" >/dev/null
    python3 -c "import re; t=open('$OUT/fail-$f.xml').read(); print('on screen at failure:', [x for x in re.findall(r'(?:text|content-desc)=\"([^\"]+)\"', t) if x][:60])"
  fi
  echo "::endgroup::"
done

# 1b. The crash report flow 05 sent: exactly what left the phone.
echo "::group::crash report check"
adb logcat -d -v raw ReactNativeJS:V '*:S' > "$OUT/logcat-js.txt"
python3 e2e/check_report.py "$OUT/logcat-js.txt" || status=1
echo "::endgroup::"

# What was on screen when a large-text step failed: visible words and ids only. Editable fields are
# skipped entirely, so nothing typed (such as the test password) can be printed.
onscreen() {
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null && adb pull /sdcard/ui.xml "$OUT/fail-$1.xml" >/dev/null
  python3 - "$OUT/fail-$1.xml" <<'PY'
import re, sys
t = open(sys.argv[1], encoding="utf-8").read()
nodes = re.findall(r"<node [^>]*>", t)
out = []
for n in nodes:
    if 'class="android.widget.EditText"' in n: continue
    for k in ("resource-id", "text", "content-desc"):
        m = re.search(k + r'="([^"]+)"', n)
        if m: out.append(m.group(1))
print("on screen at failure:", out[:80])
PY
}

# 2. Sizes: small phone (360 dp), large phone (412 dp); text at 100%, 130%, the app's maximum (160%)
#    and Android's maximum (200%). The narrow phone gets every step: the Galaxy A17's largest-text
#    findings (18 Nov, F1–F4) were cut-off names and a broken word that only show when narrow and large.
density=$(adb shell wm density | tr -dc '0-9\n' | tail -1)
for cfg in "1080x2400 420 412dp" "1080x1920 480 360dp"; do
  set -- $cfg; size=$1; dpi=$2; name=$3
  adb shell wm size "$size"; adb shell wm density "$dpi"
  case "$name" in 412dp) scales="1.0 1.6" ;; *) scales="1.0 1.3 1.6 2.0" ;; esac
  for fs in $scales; do
    adb shell settings put system font_scale "$fs"
    adb shell am force-stop "$APP"
    (cd "$OUT" && maestro test "${envs[@]}" -e "SUFFIX=${name}-text${fs}" ../flows/screens.yaml) || { echo "::warning::screens $name text $fs incomplete"; }
    # Narrow phone, largest text: the booking panel must stay readable and Reserve reachable and
    # pressable (F5/F6). Unlike the screenshots above, these fail the run.
    if [ "$name" = 360dp ] && { [ "$fs" = 1.6 ] || [ "$fs" = 2.0 ]; }; then
      echo "::group::large text $name $fs"
      if (cd "$OUT" && maestro test "${envs[@]}" -e "SUFFIX=${name}-text${fs}" ../flows/large-text-panel.yaml); then
        adb shell uiautomator dump /sdcard/ui.xml >/dev/null && adb pull /sdcard/ui.xml "$OUT/panel-$fs.xml" >/dev/null
        adb shell dumpsys window > "$OUT/window-$fs.txt"
        python3 e2e/check_reachable.py "$OUT/panel-$fs.xml" "$OUT/window-$fs.txt" "$dpi" "reserve $name text $fs" || status=1
        if (cd "$OUT" && maestro test "${envs[@]}" -e "SUFFIX=${name}-text${fs}" ../flows/large-text-reserve.yaml); then
          echo "large text $name $fs: PASS"
        else echo "::error::large-text reserve $name $fs failed"; onscreen "reserve-$fs"; status=1; fi
      else echo "::error::large-text panel $name $fs failed"; onscreen "panel-$fs"; status=1; fi
      # Unresolved booking at the same size: message in view, "Check now" reachable and pressable.
      if (cd "$OUT" && maestro test "${envs[@]}" -e "SUFFIX=${name}-text${fs}" ../flows/large-text-unresolved.yaml); then
        adb shell uiautomator dump /sdcard/ui.xml >/dev/null && adb pull /sdcard/ui.xml "$OUT/unresolved-$fs.xml" >/dev/null
        adb shell dumpsys window > "$OUT/window-u-$fs.txt"
        python3 e2e/check_reachable.py "$OUT/unresolved-$fs.xml" "$OUT/window-u-$fs.txt" "$dpi" "check-now $name text $fs" || status=1
        if (cd "$OUT" && maestro test "${envs[@]}" -e "SUFFIX=${name}-text${fs}" ../flows/large-text-unresolved-finish.yaml); then
          echo "large text unresolved $name $fs: PASS"
        else echo "::error::large-text unresolved finish $name $fs failed"; onscreen "finish-$fs"; status=1; fi
      else echo "::error::large-text unresolved $name $fs failed"; onscreen "unresolved-$fs"; status=1; fi
      echo "::endgroup::"
    fi
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
