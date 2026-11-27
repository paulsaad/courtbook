#!/usr/bin/env bash
# M12 review M1–M3 regression cases (m12_m1_m3.mjs) on its own scratch database built from this checkout's migrations,
# dropped after. LOCAL ONLY.   PSQL="sudo -u postgres psql" bash supabase/tests/payments/m12_m1_m3.sh
# CONTROL=1 builds the database WITHOUT 0098 and expects the suite to FAIL (it detects the defects M1–M3).
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
DB=courtbook_m12m
$PSQL -q -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null || exit 2
trap '$PSQL -q -d postgres -c "drop database if exists $DB" >/dev/null' EXIT
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql >/dev/null || exit 2
for f in $(ls supabase/migrations/*.sql | sort); do
  [ -n "${CONTROL:-}" ] && [[ "$(basename "$f")" == 0098_* ]] && { echo "CONTROL: skipping $f"; continue; }
  $PSQL -q -d $DB -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null || { echo "MIGRATION FAILED: $f"; exit 2; }
done
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -f supabase/seed.sql >/dev/null || exit 2
sudo -u postgres env PG_MODULE="${PG_MODULE:-/tmp/pgdeps/node_modules}" DB="postgresql:///$DB?host=/var/run/postgresql" \
  node supabase/tests/payments/m12_m1_m3.mjs > /tmp/m12_m1_m3.out 2>&1; rc=$?
cat /tmp/m12_m1_m3.out
if [ -n "${CONTROL:-}" ]; then
  # a crash is not a detection: the run must finish (its summary line) with named behavioural failures
  n=$(grep -c '^FAIL' /tmp/m12_m1_m3.out)
  if [ $rc -ne 0 ] && grep -qE "^[0-9]+ ok, [0-9]+ failed$" /tmp/m12_m1_m3.out && [ "$n" -ge 10 ]; then
    echo "CONTROL: PASS (without 0098 the suite finishes with $n named failures)"; exit 0; fi
  echo "CONTROL: FAIL (without 0098: rc=$rc, $n named failures, summary $(grep -cE '^[0-9]+ ok' /tmp/m12_m1_m3.out))"; exit 1
fi
[ $rc -eq 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"; exit $rc
