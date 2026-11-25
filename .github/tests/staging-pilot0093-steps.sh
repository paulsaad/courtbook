#!/usr/bin/env bash
# Rehearses the staging-db.yml steps for the pilot's 0093 (PR-8) LOCALLY, running the workflow's own step scripts against
# a scratch database at 0001–0092 (where staging will be once 0087–0092 are applied). Never touches staging.
#   sudo -u postgres bash .github/tests/staging-pilot0093-steps.sh
set -u
cd "$(dirname "$0")/../.."
S=courtbook_wf93; FAILS=0
export DB="postgresql:///$S" REF=localrehearsal GITHUB_SHA=0000000rehearsal
ok() { if [ "$2" = 0 ]; then echo "ok    $1"; else echo "FAIL  $1"; FAILS=$((FAILS+1)); fi; }
trap 'psql -q -d postgres -c "drop database if exists $S" >/dev/null 2>&1' EXIT
step() { python3 -c "import sys,yaml; w=yaml.safe_load(open('.github/workflows/staging-db.yml')); r=[s['run'] for j in w['jobs'].values() for s in j['steps'] if s.get('name')==sys.argv[1]]; assert len(r)==1, sys.argv[1]; print(r[0])" "$1"; }
# GitHub runs each step with "bash -e {0}" (the workflow sets no shell:), so the rehearsal does too
run_step() { local name=$1; shift; env "$@" bash -e -c "$(step "$name")" 2>&1; }
applied93() { psql -At -d $S -c "select count(*) from staging_meta.applied where name = '0093_closed_account_booking_lock_order.sql'"; }
fp() { psql -At -d $S -c "select string_agg(proname || '=' || md5(prosrc), ' ' order by proname) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('book_at_desk', 'hold_slot', 'request_account_deletion')"; }
psql -q -d postgres -c "drop database if exists $S" -c "create database $S" >/dev/null
psql -q -d $S -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql >/dev/null || exit 2
psql -q -d $S -c "create schema staging_meta; create table staging_meta.applied (name text primary key, applied_at timestamptz not null default now(), sha text)" >/dev/null
for f in $(ls supabase/migrations/*.sql | sort); do
  n=$(basename "$f"); [ "${n:0:4}" \< 0093 ] || continue
  { cat "$f"; echo; echo "insert into staging_meta.applied (name) values ('$n');"; } | psql -q -d $S -v ON_ERROR_STOP=1 -1 >/dev/null 2>&1 || { echo "setup failed: $n"; exit 2; }
done
psql -q -d $S -v ON_ERROR_STOP=1 -f supabase/seed.sql >/dev/null || exit 2
APPLY="Apply exactly the migrations named"
before=$(fp)

out=$(run_step "0093 (pilot) preflight, read only (pilot_0093_preflight)"); ok "pilot_0093_preflight passes on 0001–0092" $?
out=$(run_step "0093 (pilot) postcheck, read only (pilot_0093_postcheck)"); [ $? != 0 ]; ok "pilot_0093_postcheck fails before 0093" $?
psql -q -d $S -c "delete from staging_meta.applied where name like '0092_%'" >/dev/null
out=$(run_step "$APPLY" MIGRATIONS="0093"); [ $? != 0 ] && [ "$(applied93)" = 0 ] && [ "$(fp)" = "$before" ]
ok "0093 is refused while 0092 is not recorded as applied; nothing changed" $?
psql -q -d $S -c "insert into staging_meta.applied (name) select name from (values ('0092_club_prices_and_safe_court_changes.sql')) v(name)" >/dev/null
out=$(run_step "$APPLY" MIGRATIONS="0093"); rc=$?
[ $rc = 0 ] && echo "$out" | grep -q "0093: running the preflight" && echo "$out" | grep -q "pilot_0093_postcheck.sql: every required check ok" && [ "$(applied93)" = 1 ]
ok "apply 0093: preflight first, applied, postcheck ran and passed, recorded" $?
out=$(run_step "$APPLY" MIGRATIONS="0093"); [ $? != 0 ] && echo "$out" | grep -q "already applied"; ok "applying 0093 again is refused" $?
out=$(run_step "0093 (pilot) preflight, read only (pilot_0093_preflight)"); [ $? != 0 ]; ok "pilot_0093_preflight fails once 0093 is applied" $?
out=$(run_step "0093 (pilot) functional checks, one transaction rolled back (pilot_0093_functional)"); rc=$?
[ $rc = 0 ] && echo "$out" | grep -q "^10 checks, 0 failed$" && echo "$out" | grep -q "must be 0"
ok "pilot_0093_functional passes and leaves nothing ($(echo "$out" | grep -m1 'checks,'))" $?
[ $rc = 0 ] || echo "$out" | grep -E "FAIL|ERROR" | head -5
[ "$(psql -At -d $S -c "select count(*) from courts where name like 'zz-pilot93-%'")|$(psql -At -d $S -c "select payment_mode from clubs where slug = 'batroun'")" = "0|simulated" ]
ok "...no temporary court left; the demo club's payment mode as before" $?
out=$(run_step "0093 (pilot) postcheck, read only (pilot_0093_postcheck)"); ok "pilot_0093_postcheck passes" $?
out=$(run_step "Undo 0093 (pilot), one transaction (pilot_0093_rollback)" CONFIRM=wrong); [ $? != 0 ] && echo "$out" | grep -q "does not match" && [ "$(applied93)" = 1 ]
ok "pilot_0093_rollback refuses a wrong confirm_ref; nothing changed" $?
psql -q -d $S -c "insert into staging_meta.applied (name) values ('0094_later.sql')" >/dev/null
after=$(fp)
out=$(run_step "Undo 0093 (pilot), one transaction (pilot_0093_rollback)" CONFIRM=$REF); [ $? != 0 ] && echo "$out" | grep -q "migrations after 0093 are applied" && [ "$(fp)" = "$after" ]
ok "pilot_0093_rollback refuses while a later migration is recorded; nothing changed" $?
psql -q -d $S -c "delete from staging_meta.applied where name = '0094_later.sql'" >/dev/null
out=$(run_step "Undo 0093 (pilot), one transaction (pilot_0093_rollback)" CONFIRM=$REF); rc=$?
[ $rc = 0 ] && [ "$(applied93)" = 0 ] && [ "$(fp)" = "$before" ]; ok "pilot_0093_rollback restores the three exact previous definitions and forgets 0093 ($(echo "$out" | tail -1))" $?
out=$(run_step "0093 (pilot) preflight, read only (pilot_0093_preflight)"); ok "pilot_0093_preflight passes again after the rollback" $?
out=$(run_step "$APPLY" MIGRATIONS="0093"); [ $? = 0 ] && [ "$(applied93)" = 1 ] && [ "$(fp)" = "$after" ]; ok "0093 applies again after the rollback (same definitions)" $?
echo "RESULT: $([ $FAILS = 0 ] && echo PASS || echo FAIL)"
[ $FAILS = 0 ]
