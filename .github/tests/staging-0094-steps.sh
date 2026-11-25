#!/usr/bin/env bash
# Rehearses the staging-db.yml steps for 0094 (apply gate, postcheck, functional, rollbacks) LOCALLY, by running the
# workflow's own step scripts against a scratch database. Never touches staging. Run as a user that can reach the local
# database without a password (e.g. sudo -u postgres):
#   sudo -u postgres bash .github/tests/staging-0094-steps.sh
set -u
cd "$(dirname "$0")/../.."
S=courtbook_wf94; FAILS=0
export DB="postgresql:///$S" REF=localrehearsal GITHUB_SHA=0000000rehearsal
ok() { if [ "$2" = 0 ]; then echo "ok    $1"; else echo "FAIL  $1"; FAILS=$((FAILS+1)); fi; }
trap 'psql -q -d postgres -c "drop database if exists $S" >/dev/null 2>&1' EXIT
step() { python3 -c "import sys,yaml; w=yaml.safe_load(open('.github/workflows/staging-db.yml')); r=[s['run'] for j in w['jobs'].values() for s in j['steps'] if s.get('name')==sys.argv[1]]; assert len(r)==1, sys.argv[1]; print(r[0])" "$1"; }
# GitHub runs each step with "bash -e {0}" (no shell: is set in the workflow), so the rehearsal does too
run_step() { local name=$1; shift; env "$@" bash -e -c "$(step "$name")" 2>&1; }
# scratch "staging": 0001–0093 + seed, recorded in staging_meta.applied like the workflow does
psql -q -d postgres -c "drop database if exists $S" -c "create database $S" >/dev/null
psql -q -d $S -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql >/dev/null || exit 2
psql -q -d $S -c "create schema staging_meta; create table staging_meta.applied (name text primary key, applied_at timestamptz not null default now(), sha text)" >/dev/null
for f in $(ls supabase/migrations/*.sql | sort); do
  n=$(basename "$f"); [ "${n:0:4}" \< 0094 ] || continue
  { cat "$f"; echo; echo "insert into staging_meta.applied (name) values ('$n');"; } | psql -q -d $S -v ON_ERROR_STOP=1 -1 >/dev/null 2>&1 || { echo "setup failed: $n"; exit 2; }
done
psql -q -d $S -v ON_ERROR_STOP=1 -f supabase/seed.sql >/dev/null || exit 2
APPLY="Apply exactly the migrations named"

out=$(run_step "M12.2 0094 preflight, read only (m12_2_preflight)"); ok "m12_2_preflight passes before 0094" $?
out=$(run_step "M12.1 undo 0093, one transaction (m12_1_rollback)" CONFIRM=wrong); echo "$out" | grep -q "does not match"; ok "m12_1_rollback refuses a wrong confirm_ref" $?
out=$(run_step "$APPLY" MIGRATIONS="0094 0093"); [ $? != 0 ]; ok "apply refuses 0094 together with another number" $?
out=$(run_step "$APPLY" MIGRATIONS="0094"); rc=$?
[ $rc = 0 ] && echo "$out" | grep -q "0094: running the preflight" && echo "$out" | grep -q "m12_2_0094_postcheck.sql: every required check ok"
ok "apply 0094: preflight first, applied, postcheck ran and passed" $?
[ "$(psql -At -d $S -c "select count(*) from staging_meta.applied where name = '0094_payment_reconciliation.sql'")" = 1 ]; ok "...and recorded in staging_meta.applied" $?
out=$(run_step "$APPLY" MIGRATIONS="0094"); [ $? != 0 ] && echo "$out" | grep -q "already applied"; ok "applying 0094 again is refused" $?
out=$(run_step "M12.2 0094 preflight, read only (m12_2_preflight)"); [ $? != 0 ]; ok "m12_2_preflight fails once 0094 is applied" $?
out=$(run_step "M12.2 reconciliation suite, one transaction rolled back (m12_2_functional)"); rc=$?
[ $rc = 0 ] && echo "$out" | grep -q "must be 0"; ok "m12_2_functional passes and leaves nothing ($(echo "$out" | grep -m1 'checks,'))" $?
out=$(run_step "M12.2 0094 postcheck, read only (m12_2_postcheck)"); ok "m12_2_postcheck passes after the functional run" $?
out=$(run_step "M12.1 undo 0093, one transaction (m12_1_rollback)" CONFIRM=$REF); [ $? != 0 ] && echo "$out" | grep -q "migrations after 0093 are applied (0094_payment_reconciliation.sql)"
ok "m12_1_rollback refuses while 0094 is applied" $?
[ "$(psql -At -d $S -c "select to_regclass('public.payment_attempts') is not null and to_regclass('public.payment_reconciliation') is not null")" = t ]; ok "...and nothing changed" $?
psql -q -d $S -c "insert into payment_reconciliation (provider, reconciled_until) values ('whish', now() - interval '1 day')" >/dev/null
out=$(run_step "M12.2 reconciliation suite, one transaction rolled back (m12_2_functional)"); [ $? != 0 ] && echo "$out" | grep -q "already exist: the suite was not run"
ok "m12_2_functional refuses to run over a real starting point" $?
out=$(run_step "M12.2 undo 0094, one transaction (m12_2_rollback)" CONFIRM=$REF); [ $? != 0 ] && echo "$out" | grep -q "rollback refused: a reconciliation starting point is set"
ok "m12_2_rollback refuses while a starting point is set" $?
[ "$(psql -At -d $S -c "select count(*) from staging_meta.applied where name = '0094_payment_reconciliation.sql'")|$(psql -At -d $S -c "select count(*) from payment_reconciliation")" = "1|1" ]
ok "...and nothing changed (still recorded, starting point kept)" $?
psql -q -d $S -c "delete from payment_reconciliation" >/dev/null
psql -q -d $S -c "insert into staging_meta.applied (name) values ('0095_later.sql')" >/dev/null
out=$(run_step "M12.2 undo 0094, one transaction (m12_2_rollback)" CONFIRM=$REF); [ $? != 0 ] && echo "$out" | grep -q "migrations after 0094 are applied"
ok "m12_2_rollback refuses while a later migration is recorded" $?
psql -q -d $S -c "delete from staging_meta.applied where name = '0095_later.sql'" >/dev/null
out=$(run_step "M12.2 undo 0094, one transaction (m12_2_rollback)" CONFIRM=wrong); [ $? != 0 ]; ok "m12_2_rollback refuses a wrong confirm_ref" $?
out=$(run_step "M12.2 undo 0094, one transaction (m12_2_rollback)" CONFIRM=$REF); rc=$?
[ $rc = 0 ] && [ "$(psql -At -d $S -c "select to_regclass('public.payment_reconciliation') is null and not exists (select 1 from staging_meta.applied where name like '0094%')")" = t ]
ok "m12_2_rollback undoes 0094 and forgets it ($(echo "$out" | tail -1))" $?
out=$(run_step "M12.2 0094 preflight, read only (m12_2_preflight)"); ok "m12_2_preflight passes again after the rollback" $?
echo "RESULT: $([ $FAILS = 0 ] && echo PASS || echo FAIL)"
[ $FAILS = 0 ]
