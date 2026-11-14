#!/usr/bin/env bash
# Which app a build or update is for, and proof that it is wired to the right database.
#   live    → CourtBook          channel preview, EAS environment "preview",      live database
#   staging → CourtBook Staging  channel staging, EAS environment "development",  staging database
# (EAS's free plan has only the three standard environments, so "development" holds the staging
# app's settings; the development build profile is not used.)
# For staging, the database settings are copied into EAS from the GitHub secrets every time, so
# GitHub is the single place they are kept. Then, for either app, the settings EAS will actually use
# are read back and the database project is checked against the app. Any mismatch stops the run
# before anything is built or published. Run from mobile/.
set -euo pipefail
APP="${1:?live or staging}"
LIVE_REF=lgujfbwunokobjxlvpuf
STAGING_REF=pwznauyioqykdwodwpvx
case "$APP" in
  live)    EAS_ENV=preview;     CHANNEL=preview; PROFILE=preview; VARIANT="";      WANT=$LIVE_REF ;;
  staging) EAS_ENV=development; CHANNEL=staging; PROFILE=staging; VARIANT=staging; WANT=$STAGING_REF ;;
  *) echo "::error::app must be live or staging"; exit 1 ;;
esac

if [ "$APP" = staging ]; then
  : "${STAGING_SUPABASE_URL:?STAGING_SUPABASE_URL secret missing}" "${STAGING_ANON_KEY:?STAGING_ANON_KEY secret missing}"
  eas env:set "$EAS_ENV" --name EXPO_PUBLIC_SUPABASE_URL --value "$STAGING_SUPABASE_URL" --visibility plaintext --non-interactive >/dev/null
  eas env:set "$EAS_ENV" --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value "$STAGING_ANON_KEY" --visibility sensitive --non-interactive >/dev/null
  eas env:set "$EAS_ENV" --name APP_VARIANT --value staging --visibility plaintext --non-interactive >/dev/null
fi

eas env:pull "$EAS_ENV" --path /tmp/app.env --non-interactive >/dev/null
url=$(grep -E '^EXPO_PUBLIC_SUPABASE_URL=' /tmp/app.env | head -1 | cut -d= -f2- | tr -d '"'"'"' ')
rm -f /tmp/app.env
ref=$(printf '%s' "$url" | sed -nE 's#^https://([a-z0-9]{20})\.supabase\.co/?$#\1#p')
if [ "$ref" != "$WANT" ]; then
  echo "::error::The $APP app's EAS environment '$EAS_ENV' points at '${ref:-$url}', not $WANT. Nothing was built or published."
  exit 1
fi
echo "App: $APP · EAS environment: $EAS_ENV · channel: $CHANNEL · database project: $ref (correct for this app)"
{
  echo "EAS_ENV=$EAS_ENV"; echo "CHANNEL=$CHANNEL"; echo "PROFILE=$PROFILE"
  [ -n "$VARIANT" ] && echo "APP_VARIANT=$VARIANT"
} >> "${GITHUB_ENV:-/dev/null}"
