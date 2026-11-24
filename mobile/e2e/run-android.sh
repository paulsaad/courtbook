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

# M3 screens only (workflow input suite = m3-screens): sign in, then Find a game and the Game screen
# in every state at three text sizes, and a TalkBack audit of each. No booking flows.
if [ "${SUITE:-full}" = "m3-screens" ]; then
  mkdir -p "$OUT/shots/m3"
  adb shell monkey -p "$APP" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; sleep 45
  (cd "$OUT" && maestro test "${envs[@]}" ../flows/_sign-in.yaml) || { echo "::error::sign-in failed"; exit 1; }
  for cfg in "1080x2400 420 412dp 1.0 all" "1080x1920 480 360dp 1.0 some" "1080x1920 480 360dp 1.6 some" "1080x1920 480 360dp 2.0 some"; do
    set -- $cfg; adb shell wm size "$1"; adb shell wm density "$2"; adb shell settings put system font_scale "$4"
    sfx="$3-text$4"
    (cd "$OUT" && maestro test "${envs[@]}" -e "SUFFIX=$sfx" ../flows/m3-board.yaml) || { echo "::error::board $sfx"; status=1; }
    states="A B C D E"; [ "$5" = all ] && states="A B C D E playing played private full cancelled nocourt"
    for st in $states; do
      (cd "$OUT" && maestro test "${envs[@]}" -e "SUFFIX=$sfx" -e "STATE=$st" ../flows/m3-detail.yaml) || { echo "::error::detail $st $sfx"; status=1; }
    done
    if [ "$4" = 1.0 ]; then
      for route in "e2e-games?view=board" "e2e-games?view=detail&state=A&id=e2e-g" "e2e-games?view=detail&state=D&id=e2e-g" "e2e-games?view=detail&state=E&id=e2e-g"; do
        adb shell am start -W -a android.intent.action.VIEW -d "courtbook-staging://${route}" "$APP" >/dev/null; sleep 5
        adb shell uiautomator dump /sdcard/ui.xml >/dev/null && adb pull /sdcard/ui.xml "$OUT/ui.xml" >/dev/null
        python3 e2e/a11y_audit.py "$OUT/ui.xml" "$3:/${route}" "$2" | tee -a "$OUT/a11y.txt" || status=1
      done
    fi
  done
  adb shell settings put system font_scale 1.0; adb shell wm size reset; adb shell wm density reset
  adb logcat -d -v brief ReactNativeJS:V AndroidRuntime:E '*:F' '*:S' | tail -200 > "$OUT/logcat.txt"
  exit $status
fi

# M3 game actions (workflow input suite = m3-actions): one focused check on staging. The app, signed
# in as the run's account (Emma), asks to join and is declined, joins and leaves an open game, then as
# organiser declines one request and accepts another, and resolves a cancelled court. Two helper
# players act through the API (e2e/m3game.mjs), which also checks every outcome in the database.
if [ "${SUITE:-full}" = "m3-actions" ]; then
  mkdir -p "$OUT/shots/m3act"
  adb shell monkey -p "$APP" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; sleep 45
  (cd "$OUT" && maestro test "${envs[@]}" ../flows/_sign-in.yaml) || { echo "::error::sign-in failed"; exit 1; }
  m3() { echo "::group::m3game $*"; OUT="$OUT" node e2e/m3game.mjs "$@"; local r=$?; echo "::endgroup::"; return $r; }
  step() {
    local ids=(); while IFS= read -r l; do [ -n "$l" ] && ids+=(-e "$l"); done < "$OUT/m3.env"
    echo "::group::app $1"
    if (cd "$OUT" && maestro test "${envs[@]}" "${ids[@]}" "../flows/$1.yaml"); then echo "app $1: PASS"; echo "::endgroup::"; return 0; fi
    echo "::endgroup::"; echo "::error::app step $1 failed"
    # Visible words only; editable fields are skipped, so nothing typed can be printed.
    adb shell uiautomator dump /sdcard/ui.xml >/dev/null && adb pull /sdcard/ui.xml "$OUT/fail-$1.xml" >/dev/null && python3 -c "
import re,sys; t=open('$OUT/fail-$1.xml').read()
nodes=[n for n in re.findall(r'<node [^>]*>', t) if 'EditText' not in n]
print('on screen at failure:', [x for n in nodes for x in re.findall(r'(?:text|content-desc)=\"([^\"]+)\"', n) if x][:60])"
    return 1
  }
  m3 setup || { m3 cleanup; exit 1; }
  { step m3-act-ask && m3 check asked && m3 decline-emma && step m3-act-declined && m3 check declined; } || status=1
  { step m3-act-join-leave && m3 check left; } || status=1
  { step m3-act-organiser && m3 check decided && m3 cancel-booking && m3 check court-lost && step m3-act-court && m3 check resolved; } || status=1
  # Large text after the line-spacing fix: the sample states A and E at x2.0 on a 360dp screen.
  adb shell wm size 1080x1920; adb shell wm density 480; adb shell settings put system font_scale 2.0
  for st in A E; do
    (cd "$OUT" && maestro test "${envs[@]}" -e "SUFFIX=360dp-text2.0" -e "STATE=$st" ../flows/m3-detail.yaml) || { echo "::error::large text $st"; status=1; }
  done
  adb shell settings put system font_scale 1.0; adb shell wm size reset; adb shell wm density reset
  adb logcat -d -v brief ReactNativeJS:V AndroidRuntime:E '*:F' '*:S' | tail -200 > "$OUT/logcat.txt"
  m3 cleanup || true
  [ $status = 0 ] && echo "M3 game actions on staging: every step passed" || echo "::error::M3 game actions: a step failed (see above)"
  exit $status
fi

# m3-post-chat (workflow input suite = m3-post-chat): Post a game from Find a game (Ask to join), a
# helper asks to join, Edit → Join straight away accepts the request, then the chat both ways. The
# helper side and every database check are e2e/m3game.mjs.
if [ "${SUITE:-full}" = "m3-post-chat" ]; then
  mkdir -p "$OUT/shots/m3post"
  adb shell monkey -p "$APP" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; sleep 45
  (cd "$OUT" && maestro test "${envs[@]}" ../flows/_sign-in.yaml) || { echo "::error::sign-in failed"; exit 1; }
  envs+=(-e "POST_DAY=$(TZ=Asia/Beirut date -d '+2 day' +%F)")
  m3() { echo "::group::m3game $*"; OUT="$OUT" node e2e/m3game.mjs "$@"; local r=$?; echo "::endgroup::"; return $r; }
  step() {
    local ids=(); while IFS= read -r l; do [ -n "$l" ] && ids+=(-e "$l"); done < "$OUT/m3.env"
    echo "::group::app $1"
    if (cd "$OUT" && maestro test "${envs[@]}" "${ids[@]}" "../flows/$1.yaml"); then echo "app $1: PASS"; echo "::endgroup::"; return 0; fi
    echo "::endgroup::"; echo "::error::app step $1 failed"
    adb shell uiautomator dump /sdcard/ui.xml >/dev/null && adb pull /sdcard/ui.xml "$OUT/fail-$1.xml" >/dev/null && python3 -c "
import re,sys; t=open('$OUT/fail-$1.xml').read()
nodes=[n for n in re.findall(r'<node [^>]*>', t) if 'EditText' not in n]
print('on screen at failure:', [x for n in nodes for x in re.findall(r'(?:text|content-desc)=\"([^\"]+)\"', n) if x][:60])"
    return 1
  }
  m3 helpers || { m3 cleanup; exit 1; }
  { step m3-post && m3 posted && step m3-edit && m3 edited && step m3-chat && m3 chat-sent && step m3-chat-reply; } || status=1
  adb logcat -d -v brief ReactNativeJS:V AndroidRuntime:E '*:F' '*:S' | tail -200 > "$OUT/logcat.txt"
  m3 cleanup || true
  [ $status = 0 ] && echo "M3 post, edit and chat on staging: every step passed" || echo "::error::M3 post/edit/chat: a step failed (see above)"
  exit $status
fi

# crash-privacy (workflow input suite = crash-privacy, M5): the privacy probe (synthetic personal data
# in every channel), checked on the way out (check_report.py --probe), then a real native crash and a
# relaunch so the native SDK sends it. What Sentry received is read there (docs/m5/crash-privacy.md);
# the run prints the time window and release to look for.
if [ "${SUITE:-full}" = "crash-privacy" ]; then
  adb logcat -c
  echo "crash-privacy: window starts $(date -u +%FT%TZ)"
  for f in 06-privacy-probe 07-native-crash; do
    if (cd "$OUT" && maestro test "${envs[@]}" "../flows/$f.yaml"); then echo "flow $f: PASS"; else echo "::error::flow $f failed"; status=1; fi
    [ "$f" = 06-privacy-probe ] && { adb logcat -d -v raw ReactNativeJS:V '*:S' > "$OUT/logcat-js.txt"; python3 e2e/check_report.py "$OUT/logcat-js.txt" --probe || status=1; }
  done
  sleep 45   # the native crash report is sent from the relaunched app
  adb logcat -d -v brief Sentry:V '*:S' | grep -iE "envelope|sent|crash|error" | grep -viE "probe|person|@" | tail -40 || true
  echo "crash-privacy: window ends $(date -u +%FT%TZ)"
  adb logcat -d -v brief ReactNativeJS:V AndroidRuntime:E '*:F' '*:S' | tail -200 > "$OUT/logcat.txt"
  exit $status
fi

# booking-text (workflow input suite = booking-text): only the booking screens at the one setting where
# the Android line-height correction applies (text above the app's 1.6 cap): 360 dp at x2.0 —
# screenshots of every main screen, the booking panel with Reserve reachable and pressed, and the
# unresolved-booking recovery. Sections 0, 1 and the TalkBack audit are skipped.
BOOKING_TEXT=0; [ "${SUITE:-full}" = "booking-text" ] && BOOKING_TEXT=1
if [ $BOOKING_TEXT = 1 ]; then
  adb shell monkey -p "$APP" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; sleep 45
  (cd "$OUT" && maestro test "${envs[@]}" ../flows/_sign-in.yaml) || { echo "::error::sign-in failed"; exit 1; }
fi

if [ $BOOKING_TEXT = 0 ]; then
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
# A fresh screen dump or nothing: `uiautomator dump` can fail while the screen animates yet exit 0,
# leaving the previous file behind, so the old file is removed first and its absence is an error.
fi  # sections 0, 1, 1b

dumpui() {
  adb shell rm -f /sdcard/ui.xml
  for _ in 1 2 3 4 5; do
    adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
    if adb shell ls /sdcard/ui.xml >/dev/null 2>&1; then adb pull /sdcard/ui.xml "$1" >/dev/null && return 0; fi
    sleep 2
  done
  echo "::error::no fresh screen dump for $1"; return 1
}
onscreen() {
  adb exec-out screencap -p > "$OUT/shots/sizes/fail-$1.png" || true   # works even while animating
  dumpui "$OUT/fail-$1.xml" || return 0
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
cfgs=("1080x2400 420 412dp" "1080x1920 480 360dp"); [ $BOOKING_TEXT = 1 ] && cfgs=("1080x1920 480 360dp")
for cfg in "${cfgs[@]}"; do
  set -- $cfg; size=$1; dpi=$2; name=$3
  adb shell wm size "$size"; adb shell wm density "$dpi"
  case "$name" in 412dp) scales="1.0 1.6" ;; *) scales="1.0 1.3 1.6 2.0" ;; esac
  [ $BOOKING_TEXT = 1 ] && scales="2.0"
  for fs in $scales; do
    adb shell settings put system font_scale "$fs"
    adb shell am force-stop "$APP"
    (cd "$OUT" && maestro test "${envs[@]}" -e "SUFFIX=${name}-text${fs}" ../flows/screens.yaml) || { echo "::warning::screens $name text $fs incomplete"; }
    # Narrow phone, largest text: the booking panel must stay readable and Reserve reachable and
    # pressable (F5/F6). Unlike the screenshots above, these fail the run.
    if [ "$name" = 360dp ] && { [ "$fs" = 1.6 ] || [ "$fs" = 2.0 ]; }; then
      echo "::group::large text $name $fs"
      if (cd "$OUT" && maestro test "${envs[@]}" -e "SUFFIX=${name}-text${fs}" ../flows/large-text-panel.yaml); then
        adb shell dumpsys window > "$OUT/window-$fs.txt"
        { dumpui "$OUT/panel-$fs.xml" && python3 e2e/check_reachable.py "$OUT/panel-$fs.xml" "$OUT/window-$fs.txt" "$dpi" "reserve $name text $fs" "Reserve court"; } || status=1
        if (cd "$OUT" && maestro test "${envs[@]}" -e "SUFFIX=${name}-text${fs}" ../flows/large-text-reserve.yaml); then
          echo "large text $name $fs: PASS"
        else echo "::error::large-text reserve $name $fs failed"; onscreen "reserve-$fs"; status=1; fi
      else echo "::error::large-text panel $name $fs failed"; onscreen "panel-$fs"; status=1; fi
      # Unresolved booking at the same size: message in view, "Check now" reachable and pressable.
      if (cd "$OUT" && maestro test "${envs[@]}" -e "SUFFIX=${name}-text${fs}" ../flows/large-text-unresolved.yaml); then
        adb shell dumpsys window > "$OUT/window-u-$fs.txt"
        { dumpui "$OUT/unresolved-$fs.xml" && python3 e2e/check_reachable.py "$OUT/unresolved-$fs.xml" "$OUT/window-u-$fs.txt" "$dpi" "check-now $name text $fs" "Check now"; } || status=1
        if (cd "$OUT" && maestro test "${envs[@]}" -e "SUFFIX=${name}-text${fs}" ../flows/large-text-unresolved-finish.yaml); then
          echo "large text unresolved $name $fs: PASS"
        else echo "::error::large-text unresolved finish $name $fs failed"; onscreen "finish-$fs"; status=1; fi
      else echo "::error::large-text unresolved $name $fs failed"; onscreen "unresolved-$fs"; status=1; fi
      echo "::endgroup::"
    fi
  done
  adb shell settings put system font_scale 1.0
  # 3. TalkBack audit of each screen at this size, normal text.
  [ $BOOKING_TEXT = 1 ] && continue
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
