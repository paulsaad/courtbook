#!/usr/bin/env bash
# Booking journey acceptance on a fresh local API (start → journey.mjs → stop). LOCAL ONLY.
#   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh && PSQL="sudo -u postgres psql" bash supabase/tests/api/journey.sh
set -u
cd "$(dirname "$0")/../../.."
bash supabase/tests/api/start.sh > /tmp/courtbook-api/start.log 2>&1 || { cat /tmp/courtbook-api/start.log; exit 2; }
chmod 644 /tmp/courtbook-api/env
sudo -u postgres env PG_MODULE="${PG_MODULE:-/tmp/pgdeps/node_modules}" node --experimental-strip-types --no-warnings \
  --import ./supabase/tests/api/register.mjs supabase/tests/api/journey.mjs; rc=$?
bash supabase/tests/api/stop.sh
exit $rc
