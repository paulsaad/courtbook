#!/usr/bin/env bash
# Role matrix for the booking and money boundaries (role_matrix_m12.mjs) on its own scratch database, dropped after.
# LOCAL ONLY.   PSQL="sudo -u postgres psql" bash supabase/tests/races/role_matrix_m12.sh
# CONTROL=1 deliberately breaks two rules (players may record payment results; staff read every booking) and expects
# the matrix to fail on exactly those, proving it detects them.
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
DB=courtbook_role_matrix
$PSQL -q -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null || exit 2
trap '$PSQL -q -d postgres -c "drop database if exists $DB" >/dev/null' EXIT
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql >/dev/null || exit 2
for f in $(ls supabase/migrations/*.sql | sort); do
  $PSQL -q -d $DB -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null || { echo "MIGRATION FAILED: $f"; exit 2; }
done
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -f supabase/seed.sql >/dev/null || exit 2
if [ -n "${CONTROL:-}" ]; then
  $PSQL -q -d $DB -c "grant execute on function record_attempt_result(uuid, text, text, numeric, text) to authenticated;
    create policy zz_control on bookings for select to authenticated using (true);" >/dev/null
  echo "CONTROL: two rules deliberately broken"
fi
sudo -u postgres env PG_MODULE="${PG_MODULE:-/tmp/pgdeps/node_modules}" DB="postgresql:///$DB?host=/var/run/postgresql" \
  node supabase/tests/races/role_matrix_m12.mjs > /tmp/role_matrix_m12.out 2>&1; rc=$?
cat /tmp/role_matrix_m12.out
if [ -n "${CONTROL:-}" ]; then
  if grep -q "^FAIL  R13 player A calls server-only record_attempt_result" /tmp/role_matrix_m12.out \
     && grep -q "^FAIL  R19 staff X reads club Y" /tmp/role_matrix_m12.out; then echo "CONTROL: PASS (both broken rules detected)"; exit 0; fi
  echo "CONTROL: FAIL"; exit 1
fi
[ $rc -eq 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"; exit $rc
