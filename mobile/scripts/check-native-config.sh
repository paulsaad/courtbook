#!/usr/bin/env bash
# Checks what a native build would contain, without building: runs `expo prebuild` for both apps
# (live and APP_VARIANT=staging) into a throwaway copy, then inspects the generated Android manifest,
# iOS Info.plist and privacy manifest. Writes nothing to this checkout. Exit 0 only if every check holds.
#   bash scripts/check-native-config.sh            (from mobile/)
# Release-audit findings A1 (unused Android permissions) and I1 (iOS privacy manifest), and N2 (Face ID
# usage text), plus the staging/live isolation that must survive those changes.
set -u
cd "$(dirname "$0")/.."
here=$(pwd)
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
fails=0
chk() { if [ "$2" = true ]; then echo "ok    $1"; else echo "FAIL  $1  [${3:-}]"; fails=$((fails+1)); fi; }
plist() { python3 -c "import plistlib,sys,json; print(json.dumps(plistlib.load(open(sys.argv[1],'rb'))))" "$1"; }

for variant in live staging; do
  d=$work/$variant; mkdir -p "$d"
  # a copy of the project without node_modules (linked) and without any generated native folders
  tar -C "$here" --exclude=./node_modules --exclude=./ios --exclude=./android -cf - . | tar -C "$d" -xf -
  ln -s "$here/node_modules" "$d/node_modules"
  if [ $variant = staging ]; then export APP_VARIANT=staging; else unset APP_VARIANT; fi
  (cd "$d" && CI=1 npx expo prebuild --no-install --platform all >"$d/prebuild.log" 2>&1) || { echo "FAIL prebuild $variant (see log)"; tail -5 "$d/prebuild.log"; exit 1; }
done
unset APP_VARIANT

for variant in live staging; do
  d=$work/$variant
  man=$d/android/app/src/main/AndroidManifest.xml
  app=$(ls -d "$d"/ios/*/ | grep -v -e Pods -e '.xcodeproj' -e '.xcworkspace' | head -1)
  info=$app/Info.plist; priv=$app/PrivacyInfo.xcprivacy
  perms=$(grep -o 'uses-permission android:name="[^"]*"' "$man" | sed 's/.*name="//; s/"//' | sort | tr '\n' ' ')
  removed=$(grep -o '<uses-permission android:name="[^"]*" tools:node="remove"/>' "$man" | sed 's/.*name="//; s/".*//' | sort | tr '\n' ' ')
  kept=$(grep 'uses-permission' "$man" | grep -v 'tools:node="remove"' | sed 's/.*name="//; s/".*//' | sort | tr '\n' ' ')
  echo "== $variant: Android permissions declared by the app: $kept| removed from the merged manifest: $removed"
  chk "A1 $variant: the app itself declares only INTERNET and VIBRATE (haptics)" "$([ "$kept" = "android.permission.INTERNET android.permission.VIBRATE " ] && echo true)" "$kept"
  chk "A1 $variant: SYSTEM_ALERT_WINDOW and external storage are removed even if a library adds them" \
    "$(for p in SYSTEM_ALERT_WINDOW READ_EXTERNAL_STORAGE WRITE_EXTERNAL_STORAGE; do echo "$removed" | grep -q "android.permission.$p " || echo missing; done | grep -q missing || echo true)" "$removed"
  chk "N2 $variant: no Face ID usage text (the app never uses Face ID)" "$(plist "$info" | python3 -c "import json,sys; print('true' if 'NSFaceIDUsageDescription' not in json.load(sys.stdin) else 'false')")"
  chk "I1 $variant: the app target has a privacy manifest" "$([ -f "$priv" ] && echo true)" "$priv"
  if [ -f "$priv" ]; then
    got=$(plist "$priv" | python3 -c "
import json,sys
m=json.load(sys.stdin)
print(' '.join(sorted(t['NSPrivacyAccessedAPIType'].replace('NSPrivacyAccessedAPICategory','')+':'+','.join(sorted(t['NSPrivacyAccessedAPITypeReasons'])) for t in m.get('NSPrivacyAccessedAPITypes',[]))), m.get('NSPrivacyTracking'), len(m.get('NSPrivacyTrackingDomains',[])), len(m.get('NSPrivacyCollectedDataTypes',[])))")
    chk "I1 $variant: declares DiskSpace, FileTimestamp, SystemBootTime, UserDefaults with approved reasons; no tracking" \
      "$([ "$got" = "DiskSpace:E174.1 FileTimestamp:C617.1 SystemBootTime:35F9.1 UserDefaults:CA92.1 False 0 0" ] && echo true)" "$got"
  fi
  pkg=$(grep -o 'package="[^"]*"' "$man" | head -1); grep -q 'applicationId' "$d/android/app/build.gradle" && pkg=$(grep -o "applicationId '[^']*'" "$d/android/app/build.gradle")
  bid=$(plist "$info" | python3 -c "import json,sys; print(json.load(sys.stdin).get('CFBundleIdentifier',''))")
  [ "$bid" = '$(PRODUCT_BUNDLE_IDENTIFIER)' ] && bid=$(grep -o 'PRODUCT_BUNDLE_IDENTIFIER = [^;]*' "$d"/ios/*.xcodeproj/project.pbxproj | head -1 | sed 's/.*= //; s/"//g')
  name=$(plist "$info" | python3 -c "import json,sys; print(json.load(sys.stdin).get('CFBundleDisplayName',''))")
  schemes=$(plist "$info" | python3 -c "import json,sys; print(' '.join(s for t in json.load(sys.stdin).get('CFBundleURLTypes',[]) for s in t.get('CFBundleURLSchemes',[])))")
  echo "   identity: android $pkg; ios $bid; name '$name'; url schemes: $schemes"
  eval "id_$variant=\"\$pkg|\$bid|\$name|\$schemes\""
done
chk "isolation: live is app.courtbook.mobile, 'CourtBook', scheme courtbook" "$(echo "$id_live" | grep -q "applicationId 'app.courtbook.mobile'|app.courtbook.mobile|CourtBook|courtbook " && echo true)" "$id_live"
chk "isolation: staging is app.courtbook.mobile.staging, 'CourtBook Staging', scheme courtbook-staging, nothing shared" \
  "$(echo "$id_staging" | grep -q "applicationId 'app.courtbook.mobile.staging'|app.courtbook.mobile.staging|CourtBook Staging|courtbook-staging " && ! echo "$id_staging" | grep -qE "(^| )courtbook( |$)" && echo true)" "$id_staging"
echo
[ $fails = 0 ] && echo "RESULT: PASS" || { echo "RESULT: FAIL ($fails)"; exit 1; }
