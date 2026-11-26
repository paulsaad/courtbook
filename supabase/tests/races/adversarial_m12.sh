#!/usr/bin/env bash
# Adversarial booking and payment suite (adversarial_m12.mjs) on its own scratch database built from this checkout's
# migrations, dropped after. LOCAL ONLY.   PSQL="sudo -u postgres psql" bash supabase/tests/races/adversarial_m12.sh
# CONTROL=1 builds the database WITHOUT 0097 and expects S16/S16b to fail (proves the suite detects the defect).
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
DB=courtbook_adversarial
$PSQL -q -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null || exit 2
trap '$PSQL -q -d postgres -c "drop database if exists $DB" >/dev/null' EXIT
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql >/dev/null || exit 2
for f in $(ls supabase/migrations/*.sql | sort); do
  [ -n "${CONTROL:-}" ] && [[ "$(basename "$f")" == 0097_* ]] && { echo "CONTROL: skipping $f"; continue; }
  $PSQL -q -d $DB -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null || { echo "MIGRATION FAILED: $f"; exit 2; }
done
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -f supabase/seed.sql >/dev/null || exit 2
sudo -u postgres env PG_MODULE="${PG_MODULE:-/tmp/pgdeps/node_modules}" DB="postgresql:///$DB?host=/var/run/postgresql" \
  node supabase/tests/races/adversarial_m12.mjs > /tmp/adversarial_m12.out 2>&1; rc=$?
cat /tmp/adversarial_m12.out
if [ -n "${CONTROL:-}" ]; then
  if [ $rc -ne 0 ] && grep -q "^FAIL  S16:" /tmp/adversarial_m12.out && grep -q "^FAIL  S16b:" /tmp/adversarial_m12.out \
     && [ "$(grep -c '^FAIL' /tmp/adversarial_m12.out)" = 2 ]; then echo "CONTROL: PASS (exactly S16 and S16b fail without 0097)"; exit 0; fi
  echo "CONTROL: FAIL (expected exactly S16 and S16b to fail)"; exit 1
fi
[ $rc -eq 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"; exit $rc
