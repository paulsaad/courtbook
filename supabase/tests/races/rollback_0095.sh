#!/usr/bin/env bash
# 0095 rollback rehearsal (LOCAL ONLY, scratch databases, dropped after): 0001–0094 → 0095 → 0095_down gives a schema
# identical to 0001–0094 (fingerprint); 0095 applies again after it.
#   PSQL="sudo -u postgres psql" bash supabase/tests/races/rollback_0095.sh
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
A=courtbook_rb94; B=courtbook_rb95; FAILS=0
ok() { if [ "$2" = 0 ]; then echo "ok    $1"; else echo "FAIL  $1"; FAILS=$((FAILS+1)); fi; }
trap '$PSQL -q -d postgres -c "drop database if exists $A" -c "drop database if exists $B" >/dev/null 2>&1' EXIT
$PSQL -q -d postgres -c "drop database if exists $A" -c "drop database if exists $B" -c "create database $A" >/dev/null
$PSQL -q -d $A -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql >/dev/null || exit 2
for f in $(ls supabase/migrations/*.sql | sort); do
  n=$(basename "$f" | cut -c1-4); [ "$n" \> "0094" ] && break
  $PSQL -q -d $A -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null 2>&1 || { echo "migration failed: $f"; exit 2; }
done
$PSQL -q -d postgres -c "create database $B template $A" >/dev/null
fp() { $PSQL -At -d $1 -f supabase/tests/schema_fingerprint.sql; }
$PSQL -q -d $B -v ON_ERROR_STOP=1 -1 -f supabase/migrations/0095_deletion_booking_lock_order.sql >/dev/null 2>&1; ok "0095 applies on 0001–0094" $?
diff <(fp $A) <(fp $B) >/dev/null; [ $? != 0 ]; ok "0095 changes the schema fingerprint (the two functions)" $?
$PSQL -q -d $B -v ON_ERROR_STOP=1 -1 -f supabase/rollback/0095_down.sql >/dev/null 2>&1; ok "the rollback applies" $?
diff <(fp $A) <(fp $B) >/dev/null; ok "after the rollback the schema is identical to 0001–0094" $?
$PSQL -q -d $B -v ON_ERROR_STOP=1 -1 -f supabase/migrations/0095_deletion_booking_lock_order.sql >/dev/null 2>&1; ok "0095 applies again after the rollback" $?
echo "RESULT: $([ $FAILS = 0 ] && echo PASS || echo FAIL)"
[ $FAILS = 0 ]
