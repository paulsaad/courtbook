#!/usr/bin/env bash
# 0095 staging package rehearsal (LOCAL ONLY, scratch databases, dropped after):
#   1. the preflight passes on 0001–0094 and fails once 0095 is there
#   2. 0095 applies; the postcheck passes; the functional suite passes and leaves nothing behind
#   3. supabase/rollback/0095_down.sql gives a schema identical to 0001–0094 (fingerprint); 0095 applies again
#   4. with a starting point (watermark) or any reconciliation issue the rollback refuses and changes nothing
#   PSQL="sudo -u postgres psql" bash supabase/tests/payments/rollback_0095.sh
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
A=courtbook_rb94; B=courtbook_rb95; FAILS=0
ok() { if [ "$2" = 0 ]; then echo "ok    $1"; else echo "FAIL  $1"; FAILS=$((FAILS+1)); fi; }
trap '$PSQL -q -d postgres -c "drop database if exists $A" -c "drop database if exists $B" >/dev/null 2>&1' EXIT
$PSQL -q -d postgres -c "drop database if exists $A" -c "drop database if exists $B" -c "create database $A" >/dev/null
$PSQL -q -d $A -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql >/dev/null || exit 2
for f in $(ls supabase/migrations/*.sql | sort); do
  [ "$(basename "$f" | cut -c1-4)" \< 0095 ] || continue
  $PSQL -q -d $A -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null 2>&1 || { echo "migration failed: $f"; exit 2; }
done
$PSQL -q -d $A -v ON_ERROR_STOP=1 -f supabase/seed.sql >/dev/null || exit 2
$PSQL -q -d postgres -c "create database $B template $A" >/dev/null
fp() { $PSQL -At -d $1 -f supabase/tests/schema_fingerprint.sql; }
# read-only check files, run the way the workflow runs them (default_transaction_read_only); prints the failing items
part1_bad() { $PSQL -X -At -F '|' -d $1 -c "set default_transaction_read_only = on" -f supabase/live/m12_2_0095_preflight.sql 2>&1 | awk -F'|' '$1 == "1" && $3 != "t" { print $2 } $0 !~ /\|/ && $0 != "SET" { print }'; }
all_bad() { $PSQL -X -At -F '|' -d $1 -c "set default_transaction_read_only = on" -f supabase/live/m12_2_0095_postcheck.sql 2>&1 | awk -F'|' '$2 != "t" && $0 != "SET" { print }'; }
left() { $PSQL -At -d $1 -c "select (select count(*) from payment_reconciliation) + (select count(*) from payment_reconciliation_issues)"; }

bad=$(part1_bad $A); [ -z "$bad" ]; ok "the preflight passes on 0001–0094${bad:+ — $bad}" $?
$PSQL -q -d $B -v ON_ERROR_STOP=1 -1 -f supabase/migrations/0095_payment_reconciliation.sql >/dev/null 2>&1; ok "0095 applies on 0001–0094" $?
bad=$(all_bad $B); [ -z "$bad" ]; ok "the postcheck passes${bad:+ — $bad}" $?
part1_bad $B | grep -q "nothing of 0095 is here yet"; ok "the preflight fails once 0095 is there" $?
out=$($PSQL -d $B -X -q -At -f supabase/tests/payments/reconciliation_tests.sql 2>&1)
echo "$out" | grep -q ' 0 failed$' && ! echo "$out" | grep -qE '^FAIL|ERROR'; ok "the functional suite passes ($(echo "$out" | tail -1))" $?
[ "$(left $B)" = 0 ]; ok "...and leaves no watermark or issue behind" $?
bad=$(all_bad $B); [ -z "$bad" ]; ok "the postcheck still passes after the functional suite${bad:+ — $bad}" $?
$PSQL -q -d $B -v ON_ERROR_STOP=1 -1 -f supabase/rollback/0095_down.sql >/dev/null 2>&1; ok "the rollback applies" $?
diff <(fp $A) <(fp $B) >/dev/null; ok "after the rollback the schema is identical to 0001–0094" $?
$PSQL -q -d $B -v ON_ERROR_STOP=1 -1 -f supabase/migrations/0095_payment_reconciliation.sql >/dev/null 2>&1; ok "0095 applies again after the rollback" $?
before=$(fp $B | md5sum)
$PSQL -q -d $B -c "insert into payment_reconciliation (provider, reconciled_until) values ('whish', now() - interval '1 day')" >/dev/null
out=$($PSQL -q -d $B -v ON_ERROR_STOP=1 -1 -f supabase/rollback/0095_down.sql 2>&1)
echo "$out" | grep -q "rollback refused: a reconciliation starting point is set"; ok "with a starting point set the rollback refuses" $?
[ "$(fp $B | md5sum)" = "$before" ] && [ "$(left $B)" = 1 ]; ok "...and nothing changed" $?
$PSQL -q -d $B -c "delete from payment_reconciliation" -c "insert into payment_reconciliation_issues (provider, provider_ref, code) values ('whish', 'R-1', 'charge_evidence_conflict')" >/dev/null
out=$($PSQL -q -d $B -v ON_ERROR_STOP=1 -1 -f supabase/rollback/0095_down.sql 2>&1)
echo "$out" | grep -q "rollback refused: reconciliation issues exist"; ok "with a reconciliation issue the rollback refuses" $?
[ "$(fp $B | md5sum)" = "$before" ] && [ "$(left $B)" = 1 ]; ok "...and nothing changed" $?
echo "RESULT: $([ $FAILS = 0 ] && echo PASS || echo FAIL)"
[ $FAILS = 0 ]
