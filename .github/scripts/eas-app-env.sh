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

# Crash reporting: the same Sentry project for both apps (reports are told apart by environment,
# "production" or "staging", which the app sets from its bundle ID). Copied from the GitHub secret
# when present; without it the app sends nothing.
# The live app stays off until Paul decides to switch it on (2026-11-15): only staging gets the DSN,
# and the live environment has it removed if it was ever set.
if [ "$APP" = live ]; then
  eas env:delete "$EAS_ENV" --variable-name EXPO_PUBLIC_SENTRY_DSN --non-interactive >/dev/null 2>&1 || true
  echo "Crash reporting: off for the live app (not yet approved)"
elif [ -n "${SENTRY_DSN:-}" ]; then
  eas env:set "$EAS_ENV" --name EXPO_PUBLIC_SENTRY_DSN --value "$SENTRY_DSN" --visibility plaintext --non-interactive >/dev/null
  echo "Crash reporting: on (DSN from the SENTRY_DSN secret)"
else
  echo "Crash reporting: off (no SENTRY_DSN secret)"
fi

# Readable crash locations (source maps): uploaded by the build with SENTRY_AUTH_TOKEN (a secret
# EAS keeps hidden). Staging only for now, like crash reporting itself. Without the token, upload is
# switched off so a build never fails for want of it.
if [ "$APP" = staging ] && [ -n "${SENTRY_AUTH_TOKEN:-}" ]; then
  eas env:set "$EAS_ENV" --name SENTRY_AUTH_TOKEN --value "$SENTRY_AUTH_TOKEN" --visibility secret --non-interactive >/dev/null
  eas env:set "$EAS_ENV" --name SENTRY_DISABLE_AUTO_UPLOAD --value false --visibility plaintext --non-interactive >/dev/null
  echo "Source maps: uploaded to Sentry by builds"
else
  eas env:delete "$EAS_ENV" --variable-name SENTRY_AUTH_TOKEN --non-interactive >/dev/null 2>&1 || true
  eas env:set "$EAS_ENV" --name SENTRY_DISABLE_AUTO_UPLOAD --value true --visibility plaintext --non-interactive >/dev/null
  echo "Source maps: not uploaded"
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
  if [ -n "$VARIANT" ]; then echo "APP_VARIANT=$VARIANT"; fi
} >> "${GITHUB_ENV:-/dev/null}"
