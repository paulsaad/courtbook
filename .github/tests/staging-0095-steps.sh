#!/usr/bin/env bash
# Rehearses the staging-db.yml steps for 0095 (apply gate, pre/postcheck, rollback; with 0094 around it) LOCALLY, by running the
# workflow's own step scripts against a scratch database. Never touches staging. Run as a user that can reach the local
# database without a password (e.g. sudo -u postgres):
#   sudo -u postgres bash .github/tests/staging-0095-steps.sh
set -u
cd "$(dirname "$0")/../.."
S=courtbook_wf95; FAILS=0
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
applied() { psql -At -d $S -c "select string_agg(left(name, 4), ' ' order by name) from staging_meta.applied where name >= '0093'"; }
src() { psql -At -d $S -c "select string_agg(left(md5(prosrc), 8), ' ' order by proname) from pg_proc where proname in ('book_at_desk', 'hold_slot') and pronamespace = 'public'::regnamespace"; }
V93=$(src)   # book_at_desk 0053, hold_slot 0093

out=$(run_step "$APPLY" MIGRATIONS="0095"); [ $? != 0 ] && echo "$out" | grep -q "0095 needs 0094 applied first" && [ "$(applied)" = 0093 ]
ok "0095 before 0094 is refused; nothing applied" $?
out=$(run_step "$APPLY" MIGRATIONS="0094"); ok "0094 applies (its own gate)" $?
out=$(run_step "$APPLY" MIGRATIONS="0095 0094"); [ $? != 0 ] && [ "$(applied)" = "0093 0094" ]; ok "0095 with another number is refused" $?
out=$(run_step "0095 preflight, read only (m95_preflight)"); ok "m95_preflight passes at 0094" $?
# a function changed outside the migrations: 0095 must not overwrite it
bad=$(psql -At -d $S -c "select pg_get_functiondef('book_at_desk(uuid,timestamptz,timestamptz,uuid)'::regprocedure)" | sed 's/^AS \$function\$$/AS $function$\n-- edited by hand/')
printf '%s\n' "$bad" | psql -q -d $S -v ON_ERROR_STOP=1 >/dev/null
out=$(run_step "$APPLY" MIGRATIONS="0095"); [ $? != 0 ] && echo "$out" | grep -q "0095 preflight failed" && [ "$(applied)" = "0093 0094" ]
ok "a hand-edited book_at_desk makes the preflight refuse; nothing applied" $?
psql -q -d $S -v ON_ERROR_STOP=1 -f supabase/rollback/0095_down.sql >/dev/null   # puts the exact 0053/0093 text back
[ "$(src)" = "$V93" ]; ok "(test setup) exact text restored" $?
out=$(run_step "$APPLY" MIGRATIONS="0095"); rc=$?
[ $rc = 0 ] && echo "$out" | grep -q "0095: running the preflight" && echo "$out" | grep -q "m95_postcheck.sql: every required check ok" && [ "$(applied)" = "0093 0094 0095" ]
ok "apply 0095: preflight first, applied, postcheck ran and passed" $?
out=$(run_step "0095 preflight, read only (m95_preflight)"); [ $? != 0 ]; ok "m95_preflight fails once 0095 is applied" $?
out=$(run_step "0095 postcheck, read only (m95_postcheck)"); ok "m95_postcheck passes" $?
out=$(run_step "M12.2 undo 0094, one transaction (m12_2_rollback)" CONFIRM=$REF); [ $? != 0 ] && echo "$out" | grep -q "migrations after 0094 are applied (0095" && [ "$(applied)" = "0093 0094 0095" ]
ok "undoing 0094 under 0095 is refused; nothing changed" $?
out=$(run_step "M12.1 undo 0093, one transaction (m12_1_rollback)" CONFIRM=$REF); [ $? != 0 ] && [ "$(applied)" = "0093 0094 0095" ]
ok "undoing 0093 under 0094/0095 is refused; nothing changed" $?
out=$(run_step "Undo 0095, one transaction (m95_rollback)" CONFIRM=wrong); [ $? != 0 ] && [ "$(applied)" = "0093 0094 0095" ]; ok "m95_rollback refuses a wrong confirm_ref" $?
out=$(run_step "Undo 0095, one transaction (m95_rollback)" CONFIRM=$REF); rc=$?
[ $rc = 0 ] && [ "$(applied)" = "0093 0094" ] && [ "$(src)" = "$V93" ] && echo "$out" | grep -q "m95_preflight.sql: every required check ok"
ok "m95_rollback: back to the exact 0053/0093 text, forgotten, preflight passes again" $?
out=$(run_step "M12.2 undo 0094, one transaction (m12_2_rollback)" CONFIRM=$REF); [ $? = 0 ] && [ "$(applied)" = 0093 ]; ok "then 0094 can be undone" $?
out=$(run_step "$APPLY" MIGRATIONS="0094"); out2=$(run_step "$APPLY" MIGRATIONS="0095"); [ $? = 0 ] && [ "$(applied)" = "0093 0094 0095" ]; ok "0094 then 0095 apply again" $?
echo "RESULT: $([ $FAILS = 0 ] && echo PASS || echo FAIL)"
[ $FAILS = 0 ]
