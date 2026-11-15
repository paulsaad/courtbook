#!/usr/bin/env bash
# iOS simulator job (mobile/ is the working directory). Installs the CourtBook Staging simulator build
# on fresh simulators and runs Apple's accessibility audit (e2e/ios-audit) on each main screen:
#   small iPhone, normal text · small iPhone, largest text · Pro Max, normal text.
# Everything lands in e2e/out/ (audit text and screenshots).
set -uo pipefail
OUT="$PWD/e2e/out"; mkdir -p "$OUT"
APP_PATH="$PWD/e2e/CourtBookStaging.app"
status=0

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
  if ! (cd e2e/ios-audit && xcodebuild test -project CourtBookAudit.xcodeproj -scheme Audit \
        -destination "id=$udid" -derivedDataPath "$RUNNER_TEMP/audit-dd" CODE_SIGNING_ALLOWED=NO \
        TEST_RUNNER_OUT_DIR="$OUT" TEST_RUNNER_AUDIT_TAG="$tag" \
        TEST_RUNNER_E2E_EMAIL="$E2E_EMAIL" TEST_RUNNER_E2E_PASSWORD="$E2E_PASSWORD" \
        TEST_RUNNER_E2E_CLUB="$E2E_CLUB" TEST_RUNNER_E2E_DATE="$E2E_DATE" 2>&1 \
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
exit $status
