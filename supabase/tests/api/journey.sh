#!/usr/bin/env bash
# Local API acceptance (start → script → stop). LOCAL ONLY. Default script: journey.mjs; SCRIPT=security.mjs for the security checks.
#   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh && PSQL="sudo -u postgres psql" bash supabase/tests/api/journey.sh
set -u
SCRIPT=supabase/tests/api/${SCRIPT:-journey.mjs}
cd "$(dirname "$0")/../../.."
mkdir -p /tmp/courtbook-api   # a clean machine has no folder yet for the start log
bash supabase/tests/api/start.sh > /tmp/courtbook-api/start.log 2>&1 || { cat /tmp/courtbook-api/start.log; exit 2; }
chmod 644 /tmp/courtbook-api/env
sudo -u postgres env PG_MODULE="${PG_MODULE:-/tmp/pgdeps/node_modules}" node --experimental-strip-types --no-warnings \
  --import ./supabase/tests/api/register.mjs $SCRIPT; rc=$?
bash supabase/tests/api/stop.sh
exit $rc
