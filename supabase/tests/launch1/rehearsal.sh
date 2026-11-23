#!/usr/bin/env bash
# Rehearses the launch-1 staging rollout (0078–0084) on a LOCAL disposable database built at 0077, running the REAL
# staging-db.yml step scripts (apply, launch1_preflight/postcheck, m7_demo_hidden_on/off, m7_0078_postcheck) against it.
#   PSQL="sudo -u postgres psql" bash supabase/tests/launch1/rehearsal.sh
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}; DBN=courtbook_launch1_rehearsal
oks=0; fails=0
rep() { if [ "$2" = true ]; then echo "ok    $1"; oks=$((oks+1)); else echo "FAIL  $1  [$3]"; fails=$((fails+1)); fi; }
P() { $PSQL -X -q -At -d $DBN "$@"; }
# run a workflow step as the database owner, with the step's environment
step() { local action=$1 nth=$2; shift 2; python3 supabase/tests/launch1/step.py "$action" "$nth" > /tmp/launch1_step.sh
  (cd "$WT" && sudo -u postgres env DB="dbname=$DBN" GITHUB_SHA=rehearsal0 "$@" bash -e /tmp/launch1_step.sh) > /tmp/launch1_step.out 2>&1; }
applied() { P -c "select count(*) from staging_meta.applied where name ~ '^00(7[89]|8[0-4])_'"; }
$PSQL -q -d postgres -c "drop database if exists $DBN" -c "create database $DBN" >/dev/null 2>&1
P -f supabase/tests/supabase_shim.sql >/dev/null 2>&1
P -c "create schema staging_meta; create table staging_meta.applied (name text primary key, sha text, applied_at timestamptz default now())" >/dev/null
for f in $(ls supabase/migrations/*.sql | sort | awk -F/ '$NF < "0078"'); do
  { cat "$f"; echo; echo "insert into staging_meta.applied (name, sha) values ('$(basename $f)', 'rehearsal');"; } | P -v ON_ERROR_STOP=1 -1 >/dev/null 2>&1 || { echo "cannot build: $f"; exit 2; }
done
P -v ON_ERROR_STOP=1 -f supabase/seed.sql >/dev/null 2>&1 || { echo "cannot seed"; exit 2; }
# as on Supabase: signed-out visitors can run the extension support functions (btree_gist, pgcrypto) in public
P -c "do \$\$ declare r record; begin for r in select p.oid::regprocedure as sig from pg_proc p join pg_depend d on d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e' where p.pronamespace = 'public'::regnamespace loop execute format('grant execute on function %s to anon', r.sig); end loop; end \$\$" >/dev/null
WT=$(mktemp -d); cp -r .github supabase "$WT"/; chmod -R a+rX "$WT"; trap 'rm -rf "$WT"' EXIT

step launch1_preflight 1; rep "R1 launch1_preflight action passes at 0077 (+ seed)" "$([ $? = 0 ] && echo true)" "$(tail -3 /tmp/launch1_step.out)"
EXT="select p.oid::regprocedure as sig from pg_proc p join pg_depend d on d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e' where p.pronamespace = 'public'::regnamespace"
P -c "do \$\$ declare r record; begin for r in $EXT loop execute format('revoke execute on function %s from public, anon', r.sig); end loop; end \$\$" >/dev/null
step launch1_preflight 1; rep "R1b launch1_preflight passes whatever the extension functions' grants are" "$([ $? = 0 ] && echo true)" "$(grep FAIL /tmp/launch1_step.out | head -2)"
P -c "do \$\$ declare r record; begin for r in $EXT loop execute format('grant execute on function %s to anon', r.sig); end loop; end \$\$" >/dev/null
step apply 2 MIGRATIONS="0079"; rc=$?
rep "R2 apply 0079 without 0078: refused, nothing applied" "$([ $rc != 0 ] && [ "$(applied)" = 0 ] && grep -q 'need 0078 first' /tmp/launch1_step.out && echo true)" "rc $rc $(tail -2 /tmp/launch1_step.out)"
P -c "create function club_readiness(p_club uuid) returns int language sql as 'select 1'" >/dev/null
step apply 2 MIGRATIONS="0078 0079 0080 0081 0082 0083 0084"; rc=$?
rep "R3 apply with a failing preflight: refused before anything is applied" "$([ $rc != 0 ] && [ "$(applied)" = 0 ] && grep -q 'preflight failed: nothing was applied' /tmp/launch1_step.out && echo true)" "rc $rc applied $(applied)"
step launch1_preflight 1; rc=$?
rep "R4 launch1_preflight action fails the job on that state" "$([ $rc != 0 ] && echo true)" "rc $rc"
P -c "drop function club_readiness(uuid)" >/dev/null
step apply 2 MIGRATIONS="0078 0079 0080 0081 0082 0083 0084"; rc=$?
rep "R5 apply the seven: preflight passes, 7 applied, seed, postcheck run by the job and ok" "$([ $rc = 0 ] && [ "$(applied)" = 7 ] && grep -q 'launch1_postcheck.sql: every required check ok' /tmp/launch1_step.out && echo true)" "rc $rc applied $(applied) $(grep -E '::error|FAIL' /tmp/launch1_step.out | head -3)"
step launch1_postcheck 1; rep "R6 launch1_postcheck action passes" "$([ $? = 0 ] && echo true)" "$(grep -E 'FAIL|error' /tmp/launch1_step.out | head -3)"
step launch1_preflight 1; rep "R7 launch1_preflight action now fails (state is no longer 0077)" "$([ $? != 0 ] && echo true)" ""
step m7_0078_postcheck 1; rc=$?
rep "R8 the old 0078 postcheck refuses once 0084 is applied" "$([ $rc != 0 ] && grep -q 'Use launch1_postcheck' /tmp/launch1_step.out && echo true)" "rc $rc"
step m7_demo_hidden_on 1; rc=$?
rep "R9 m7_demo_hidden_on: switch on, switch check passes in the integrated state" "$([ $rc = 0 ] && [ "$(P -c "select value from app_settings where key = 'hide_demo_clubs'")" = true ] && grep -q 'demo_switch_check.sql: every required check ok' /tmp/launch1_step.out && echo true)" "rc $rc $(grep -E 'FAIL|error' /tmp/launch1_step.out | head -3)"
step m7_demo_hidden_off 1; rc=$?
rep "R10 m7_demo_hidden_off: switch off, check passes" "$([ $rc = 0 ] && [ "$(P -c "select value from app_settings where key = 'hide_demo_clubs'")" = false ] && echo true)" "rc $rc"
step launch1_postcheck 1; rep "R11 launch1_postcheck still passes with the demo switch back off" "$([ $? = 0 ] && echo true)" ""
P -c "insert into app_settings (key, value) values ('require_age_confirmation', 'true') on conflict (key) do update set value = 'true'" >/dev/null
step launch1_postcheck 1; rep "R12 launch1_postcheck fails the job if the age switch is on" "$([ $? != 0 ] && echo true)" ""
P -c "update app_settings set value = 'false' where key = 'require_age_confirmation'" >/dev/null
P -c "drop policy \"courts: read\" on courts; create policy \"courts: read\" on courts for select using (true)" >/dev/null
step m7_demo_hidden_on 1; rc=$?
rep "R13 the switch check fails the job when hiding does not work (courts readable)" "$([ $rc != 0 ] && echo true)" "rc $rc"
P -c "drop trigger match_messages_deletion_guard on match_messages" >/dev/null
step launch1_postcheck 1; rep "R14 launch1_postcheck fails the job on a missing trigger" "$([ $? != 0 ] && echo true)" ""
$PSQL -q -d postgres -c "drop database if exists $DBN" >/dev/null 2>&1
echo "summary: $oks ok, $fails FAIL"; [ $fails = 0 ] && echo "RESULT: PASS" || { echo "RESULT: FAIL"; exit 1; }
