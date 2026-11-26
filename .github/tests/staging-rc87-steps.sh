#!/usr/bin/env bash
# Rehearses the staging-db.yml steps for applying 0087–0092 after 0086 (staging's level since 24 Nov) LOCALLY, running
# the workflow's own step scripts against a scratch database. Never touches staging.
#   sudo -u postgres bash .github/tests/staging-rc87-steps.sh
set -u
cd "$(dirname "$0")/../.."
S=courtbook_wf87; FAILS=0
export DB="postgresql:///$S" REF=localrehearsal GITHUB_SHA=0000000rehearsal
ok() { if [ "$2" = 0 ]; then echo "ok    $1"; else echo "FAIL  $1"; FAILS=$((FAILS+1)); fi; }
trap 'psql -q -d postgres -c "drop database if exists $S" >/dev/null 2>&1' EXIT
step() { python3 -c "import sys,yaml; w=yaml.safe_load(open('.github/workflows/staging-db.yml')); r=[s['run'] for j in w['jobs'].values() for s in j['steps'] if s.get('name')==sys.argv[1]]; assert len(r)==1, sys.argv[1]; print(r[0])" "$1"; }
# GitHub runs each step with "bash -e {0}" (the workflow sets no shell:), so the rehearsal does too
run_step() { local name=$1; shift; env "$@" bash -e -c "$(step "$name")" 2>&1; }
applied() { psql -At -d $S -c "select count(*) from staging_meta.applied where name ~ '^00(8[7-9]|9[0-2])_'"; }
psql -q -d postgres -c "drop database if exists $S" -c "create database $S" >/dev/null
psql -q -d $S -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql >/dev/null || exit 2
psql -q -d $S -c "create schema staging_meta; create table staging_meta.applied (name text primary key, applied_at timestamptz not null default now(), sha text)" >/dev/null
for f in $(ls supabase/migrations/*.sql | sort); do
  n=$(basename "$f"); [ "${n:0:4}" \< 0087 ] || continue
  { cat "$f"; echo; echo "insert into staging_meta.applied (name) values ('$n');"; } | psql -q -d $S -v ON_ERROR_STOP=1 -1 >/dev/null 2>&1 || { echo "setup failed: $n"; exit 2; }
done
psql -q -d $S -v ON_ERROR_STOP=1 -f supabase/seed.sql >/dev/null || exit 2
APPLY="Apply exactly the migrations named"

out=$(run_step "Release candidate 0086–0091 preflight, read only (rc_preflight)"); [ $? != 0 ] && echo "$out" | grep -q "nothing of 0086–0092 is here yet"
ok "the old rc_preflight cannot pass once 0086 is applied (staging today)" $?
out=$(run_step "Release candidate 0087–0092 preflight after 0086, read only (rc87_preflight)"); rc=$?
[ $rc = 0 ]; ok "rc87_preflight passes on 0001–0086$( [ $rc = 0 ] || echo " — $(echo "$out" | grep FAIL | head -3 | tr '\n' ' ')")" $rc
# 26 Nov: an account being deleted (0086 status 'closing', as staging can have after the trial) must not stop step A
psql -q -d $S -c "insert into auth.users (id, phone) values ('f0870000-0000-4000-8000-000000000001', '+96170870001');
  select close_account_internal('f0870000-0000-4000-8000-000000000001', 'web');" >/dev/null
out=$(run_step "Release candidate 0087–0092 preflight after 0086, read only (rc87_preflight)"); rc=$?
[ $rc = 0 ]; ok "rc87_preflight passes with a deletion open in a 0086 state (closing)$( [ $rc = 0 ] || echo " — $(echo "$out" | grep FAIL | head -1)")" $rc
out=$(run_step "$APPLY" MIGRATIONS="0089"); [ $? != 0 ] && echo "$out" | grep -q "0087 is neither applied nor in this run" && [ "$(applied)" = 0 ]
ok "0089 alone is refused (0087, 0088 missing); nothing applied" $?
out=$(run_step "$APPLY" MIGRATIONS="0087 0094"); [ $? != 0 ] && [ "$(applied)" = 0 ]; ok "0087 with another number is refused; nothing applied" $?
out=$(run_step "$APPLY" MIGRATIONS="0087 0088"); rc=$?
[ $rc = 0 ] && echo "$out" | grep -q "0087–0092: running the preflight" && [ "$(applied)" = 2 ] && ! echo "$out" | grep -q "all seven applied"
ok "0087 0088: preflight first, both applied, no postcheck yet" $?
out=$(run_step "$APPLY" MIGRATIONS="0090"); [ $? != 0 ] && echo "$out" | grep -q "0089 is neither applied" && [ "$(applied)" = 2 ]
ok "resuming with a gap (0090 before 0089) is refused" $?
out=$(run_step "Release candidate 0087–0092 preflight after 0086, read only (rc87_preflight)"); [ $? != 0 ]; ok "rc87_preflight fails on a half-applied release" $?
out=$(run_step "$APPLY" MIGRATIONS="0089 0090 0091 0092"); rc=$?
[ $rc = 0 ] && [ "$(applied)" = 6 ] && echo "$out" | grep -q "all seven applied; running the postcheck" && echo "$out" | grep -q "rc_0086_0091_postcheck.sql: every required check ok" \
  && ! echo "$out" | grep -q "0087–0092: running the preflight"
ok "resuming 0089–0092: no second preflight, all applied, the 0086–0092 postcheck ran and passed" $?
out=$(run_step "Release candidate 0086–0091 postcheck, read only (rc_postcheck)"); ok "rc_postcheck passes" $?
# then the pilot's 0093 (PR-8) and only after it M12.1's 0094
out=$(run_step "$APPLY" MIGRATIONS="0094"); [ $? != 0 ] && echo "$out" | grep -q "0094 needs 0093 (pilot) applied first" \
  && [ "$(psql -At -d $S -c "select count(*) from staging_meta.applied where name ~ '^009[34]_'")" = 0 ]
ok "0094 before the pilot's 0093 is refused; nothing applied" $?
out=$(run_step "$APPLY" MIGRATIONS="0093"); [ $? = 0 ] && [ "$(psql -At -d $S -c "select count(*) from staging_meta.applied where name = '0093_closed_account_booking_lock_order.sql'")" = 1 ]
ok "the pilot's 0093 applies after 0092" $?
out=$(run_step "$APPLY" MIGRATIONS="0094"); [ $? = 0 ] && echo "$out" | grep -q "0094: running the preflight" \
  && [ "$(psql -At -d $S -c "select count(*) from staging_meta.applied where name = '0094_fee_online_payments.sql'")" = 1 ]
ok "0094 after 0093: preflight first, applied" $?
echo "RESULT: $([ $FAILS = 0 ] && echo PASS || echo FAIL)"
[ $FAILS = 0 ]
