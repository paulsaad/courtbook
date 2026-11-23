#!/usr/bin/env bash
# Rehearses the launch-1 staging rollout (0078–0084) on a LOCAL disposable database built at 0077, exactly as the
# staging workflow applies migrations (each file in its own transaction, recorded in staging_meta.applied, then the
# demo seed), with supabase/live/launch1_preflight.sql before and launch1_postcheck.sql after.
#   PSQL="sudo -u postgres psql" bash supabase/tests/launch1/rehearsal.sh
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}; DB=courtbook_launch1_rehearsal
oks=0; fails=0
rep() { if [ "$2" = true ]; then echo "ok    $1"; oks=$((oks+1)); else echo "FAIL  $1  [$3]"; fails=$((fails+1)); fi; }
P() { $PSQL -X -q -At -d $DB "$@"; }
$PSQL -q -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null
P -f supabase/tests/supabase_shim.sql >/dev/null 2>&1
P -c "create schema staging_meta; create table staging_meta.applied (name text primary key, sha text, applied_at timestamptz default now())" >/dev/null
for f in $(ls supabase/migrations/*.sql | sort | awk -F/ '$NF < "0078"'); do
  { cat "$f"; echo; echo "insert into staging_meta.applied (name, sha) values ('$(basename $f)', 'rehearsal');"; } | P -v ON_ERROR_STOP=1 -1 >/dev/null 2>&1 || { echo "cannot build: $f"; exit 2; }
done
P -v ON_ERROR_STOP=1 -f supabase/seed.sql >/dev/null 2>&1 || { echo "cannot seed"; exit 2; }
pf() { P -f supabase/live/launch1_preflight.sql | awk -F'|' '$1==1 && $3!="t" {print $2}' | tr '\n' ';'; }
pc() { P -f supabase/live/launch1_postcheck.sql | awk -F'|' '$2!="t" {print $1}' | tr '\n' ';'; }
ro() { P -c "set default_transaction_read_only = on" -f "$1" 2>&1 | grep -c ERROR; }

x=$(pf); rep "R1 preflight: every part-1 row ok at 0077 (+ seed)" "$([ -z "$x" ] && echo true)" "$x"
rep "R2 preflight runs read-only" "$([ "$(ro supabase/live/launch1_preflight.sql)" = 0 ] && echo true)" ""
n=0; okapply=true
for f in $(ls supabase/migrations/*.sql | sort | awk -F/ '$NF >= "0078"'); do
  { cat "$f"; echo; echo "insert into staging_meta.applied (name, sha) values ('$(basename $f)', 'rehearsal');"; } | P -v ON_ERROR_STOP=1 -1 >/dev/null 2>/tmp/launch1_apply.err || { okapply=false; echo "  apply failed: $f: $(tail -1 /tmp/launch1_apply.err)"; break; }
  n=$((n+1))
done
rep "R3 0078–0084 apply in order, one transaction each ($n files)" "$([ "$okapply" = true ] && [ $n = 7 ] && echo true)" "$n"
P -v ON_ERROR_STOP=1 -f supabase/seed.sql >/dev/null 2>&1; rep "R4 the demo seed still applies after them (the apply action runs it)" "$([ $? = 0 ] && echo true)" ""
x=$(pc); rep "R5 postcheck: every row ok" "$([ -z "$x" ] && echo true)" "$x"
rep "R6 postcheck runs read-only" "$([ "$(ro supabase/live/launch1_postcheck.sql)" = 0 ] && echo true)" ""
x=$(pf); rep "R7 preflight refuses once applied (cannot be mistaken for a fresh state)" "$([ -n "$x" ] && echo true)" "$x"
P -c "drop trigger match_messages_deletion_guard on match_messages" >/dev/null
x=$(pc); rep "R8 postcheck catches a missing trigger" "$([ -n "$x" ] && echo true)" "$x"
P -c "insert into app_settings (key, value) values ('require_age_confirmation', 'true') on conflict (key) do update set value = 'true'" >/dev/null
x=$(pc); rep "R9 postcheck catches a switch turned on too early" "$(echo "$x" | grep -q require_age_confirmation && echo true)" "$x"
$PSQL -q -d postgres -c "drop database if exists $DB" >/dev/null
echo "summary: $oks ok, $fails FAIL"; [ $fails = 0 ] && echo "RESULT: PASS" || { echo "RESULT: FAIL"; exit 1; }
