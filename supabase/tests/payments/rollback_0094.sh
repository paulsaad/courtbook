#!/usr/bin/env bash
# 0094 rollback rehearsal (LOCAL ONLY, scratch databases, dropped after):
#   1. 0001–0092 → 0094 → supabase/rollback/0094_down.sql gives a schema identical to 0001–0092 (fingerprint)
#   2. 0094 applies again cleanly after the rollback
#   3. with fee-only money present the rollback refuses and changes nothing
#   4. with 0095 applied on top it refuses (0095 is undone first) and changes nothing
#   PSQL="sudo -u postgres psql" bash supabase/tests/payments/rollback_0094.sh
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
A=courtbook_rb92; B=courtbook_rb94; FAILS=0
ok() { if [ "$2" = 0 ]; then echo "ok    $1"; else echo "FAIL  $1"; FAILS=$((FAILS+1)); fi; }
trap '$PSQL -q -d postgres -c "drop database if exists $A" -c "drop database if exists $B" >/dev/null 2>&1' EXIT
$PSQL -q -d postgres -c "drop database if exists $A" -c "drop database if exists $B" -c "create database $A" >/dev/null
$PSQL -q -d $A -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql >/dev/null || exit 2
# 0001–0092 only: later migrations (0095 reads 0094's tables) are rolled back first, never across 0094
for f in $(ls supabase/migrations/*.sql | sort); do
  [ "$(basename "$f" | cut -c1-4)" \< 0094 ] || continue
  $PSQL -q -d $A -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null 2>&1 || { echo "migration failed: $f"; exit 2; }
done
$PSQL -q -d $A -v ON_ERROR_STOP=1 -f supabase/seed.sql >/dev/null || exit 2
$PSQL -q -d postgres -c "create database $B template $A" >/dev/null
fp() { $PSQL -At -d $1 -f supabase/tests/schema_fingerprint.sql; }
$PSQL -q -d $B -v ON_ERROR_STOP=1 -1 -f supabase/migrations/0094_fee_online_payments.sql >/dev/null 2>&1; ok "0094 applies on 0001–0092" $?
$PSQL -q -d $B -v ON_ERROR_STOP=1 -1 -f supabase/rollback/0094_down.sql >/dev/null 2>&1; ok "the rollback applies" $?
diff <(fp $A) <(fp $B) >/dev/null; ok "after the rollback the schema is identical to 0001–0092" $?
$PSQL -q -d $B -v ON_ERROR_STOP=1 -1 -f supabase/migrations/0094_fee_online_payments.sql >/dev/null 2>&1; ok "0094 applies again after the rollback" $?
before=$(fp $B | md5sum)
$PSQL -q -d $B -c "update clubs set payment_mode = 'fee_online' where slug = 'batroun'" >/dev/null
out=$($PSQL -q -d $B -v ON_ERROR_STOP=1 -1 -f supabase/rollback/0094_down.sql 2>&1)
echo "$out" | grep -q "rollback refused: a club is in fee_online mode"; ok "with a fee_online club the rollback refuses" $?
[ "$(fp $B | md5sum)" = "$before" ]; ok "...and nothing changed" $?
$PSQL -q -d $B -c "update clubs set payment_mode = 'at_desk' where slug = 'batroun'" >/dev/null
if [ -f supabase/migrations/0095_payment_reconciliation.sql ]; then
  $PSQL -q -d $B -v ON_ERROR_STOP=1 -1 -f supabase/migrations/0095_payment_reconciliation.sql >/dev/null 2>&1; ok "0095 applies on top" $?
  before=$(fp $B | md5sum)
  out=$($PSQL -q -d $B -v ON_ERROR_STOP=1 -1 -f supabase/rollback/0094_down.sql 2>&1)
  echo "$out" | grep -q "rollback refused: 0095 is applied; undo 0095 first"; ok "with 0095 applied the 0094 rollback refuses (undo 0095 first)" $?
  [ "$(fp $B | md5sum)" = "$before" ]; ok "...and nothing changed" $?
fi
echo "RESULT: $([ $FAILS = 0 ] && echo PASS || echo FAIL)"
[ $FAILS = 0 ]
