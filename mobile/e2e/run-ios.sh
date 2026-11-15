#!/usr/bin/env bash
# iOS simulator job (mobile/ is the working directory). Installs the CourtBook Staging simulator build
# on fresh simulators and runs Apple's accessibility audit (e2e/ios-audit) on each main screen:
#   small iPhone, normal text · small iPhone, largest text · Pro Max, normal text.
# Everything lands in e2e/out/ (audit text and screenshots).
set -uo pipefail
OUT="$PWD/e2e/out"; mkdir -p "$OUT"
APP_PATH="$PWD/e2e/CourtBookStaging.app"
status=0

echo "staging database in the app bundle: $(grep -a -c pwznauyioqykdwodwpvx "$APP_PATH/main.jsbundle" || true) reference(s)"
codesign -d --entitlements - "$APP_PATH" 2>&1 | grep -E "Identifier|keychain|application-identifier" || echo "no entitlements"
read -r RUNTIME SMALL LARGE < <(python3 e2e/ios-pick.py)
(cd e2e/ios-audit && xcodegen generate --quiet) || exit 1

for cfg in "small $SMALL large" "small $SMALL accessibility-extra-extra-extra-large" "promax $LARGE large"; do
  set -- $cfg; name=$1; type=$2; size=$3
  tag="$name-$( [ "$size" = large ] && echo text-normal || echo text-largest )"
  echo "::group::audit $tag"
  udid=$(xcrun simctl create "audit-$tag" "$type" "$RUNTIME")
  xcrun simctl boot "$udid" && xcrun simctl bootstatus "$udid" -b >/dev/null
  xcrun simctl ui "$udid" content_size "$size"
  xcrun simctl install "$udid" "$APP_PATH" || { echo "::error::install failed"; status=1; continue; }
  # TEST_RUNNER_* environment variables reach the test process without the prefix.
  if ! (cd e2e/ios-audit && env TEST_RUNNER_OUT_DIR="$OUT" TEST_RUNNER_AUDIT_TAG="$tag" \
        TEST_RUNNER_E2E_EMAIL="$E2E_EMAIL" TEST_RUNNER_E2E_PASSWORD="$E2E_PASSWORD" \
        TEST_RUNNER_E2E_CLUB="$E2E_CLUB" TEST_RUNNER_E2E_DATE="$E2E_DATE" \
        xcodebuild test -project CourtBookAudit.xcodeproj -scheme Audit \
        -destination "id=$udid" -derivedDataPath "$RUNNER_TEMP/audit-dd" CODE_SIGNING_ALLOWED=NO 2>&1 \
        | tee "$OUT/xcodebuild-$tag.log" | grep -E "AUDIT\||error:|failed|passed|Test Suite" ); then
    echo "::error::audit run $tag failed"; status=1
  fi
  grep -q "\*\* TEST SUCCEEDED \*\*" "$OUT/xcodebuild-$tag.log" || { echo "::error::audit run $tag did not succeed"; status=1; }
  xcrun simctl shutdown "$udid" || true
  echo "::endgroup::"
done

echo "::group::summary"
cat "$OUT"/ios-audit-*.txt 2>/dev/null | grep -E "^(SCREEN|ERROR)" || echo "no audit output"
echo "issues by kind:"; cat "$OUT"/ios-audit-*.txt 2>/dev/null | grep -oE "^ISSUE [^ ]+ [^ ]+ \[[^]]+\]" | awk '{print $4}' | sort | uniq -c
echo "::endgroup::"

# Every finding must be fixed or reviewed and listed in ios-audit/accepted.txt.
grep -hE "^ISSUE " "$OUT"/ios-audit-*.txt 2>/dev/null > "$OUT/issues.txt" || true
grep -vE '^(#|$)' e2e/ios-audit/accepted.txt > "$OUT/accepted.re"
new=$(grep -vEf "$OUT/accepted.re" "$OUT/issues.txt" || true)
if [ -n "$new" ]; then
  echo "::error::accessibility findings not yet fixed or accepted:"; echo "$new"; status=1
else
  echo "accessibility audit: no open findings ($(wc -l < "$OUT/issues.txt" | tr -d ' ') accepted)"
fi
exit $status
