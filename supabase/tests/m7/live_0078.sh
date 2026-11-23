#!/usr/bin/env bash
# Rehearses the 0078 pack (supabase/live/0078_*.sql) on a LOCAL disposable database built at 0077.
#   PSQL="sudo -u postgres psql" bash supabase/tests/m7/live_0078.sh
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}; DB=courtbook_0078_live
oks=0; fails=0
rep() { if [ "$2" = true ]; then echo "ok    $1"; oks=$((oks+1)); else echo "FAIL  $1  [$3]"; fails=$((fails+1)); fi; }
P() { $PSQL -X -q -At -d $DB "$@"; }
$PSQL -q -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null
P -f supabase/tests/supabase_shim.sql >/dev/null 2>&1
for f in $(ls supabase/migrations/*.sql | sort | awk -F/ '$NF < "0078"'); do P -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null 2>&1 || { echo "cannot build: $f"; exit 2; }; done
P -v ON_ERROR_STOP=1 -f supabase/seed.sql >/dev/null 2>&1 || { echo "cannot seed"; exit 2; }
pf() { P -f supabase/live/0078_preflight.sql | awk -F'|' '$1==1 && $3!="t" {print $2}' | tr '\n' ';'; }
pc() { P -f supabase/live/0078_postcheck.sql | awk -F'|' '$2!="t" {print $1}' | tr '\n' ';'; }
ro() { P -c "set default_transaction_read_only = on" -f "$1" 2>&1 | grep -c ERROR; }
x=$(pf); rep "L1 preflight all ok at 0077" "$([ -z "$x" ] && echo true)" "$x"
rep "L2 preflight runs read-only" "$([ "$(ro supabase/live/0078_preflight.sql)" = 0 ] && echo true)" ""
P -v ON_ERROR_STOP=1 -1 -f supabase/migrations/0078_hide_demo_clubs.sql >/dev/null 2>&1; rep "L3 0078 applies" "$([ $? = 0 ] && echo true)" ""
x=$(pc); rep "L4 postcheck all ok, switch not set" "$([ -z "$x" ] && echo true)" "$x"
rep "L5 postcheck runs read-only" "$([ "$(ro supabase/live/0078_postcheck.sql)" = 0 ] && echo true)" ""
x=$(pf); rep "L6 preflight refuses after 0078" "$([ -n "$x" ] && echo true)" "$x"
P -c "insert into app_settings (key, value) values ('hide_demo_clubs', 'true')" >/dev/null
x=$(pc); rep "L7 postcheck all ok with the switch ON" "$([ -z "$x" ] && echo true)" "$x"
n=$(P -c "select count(*) from clubs where is_demo"); rep "L8 the rehearsal has a demo club to hide" "$([ "$n" -ge 1 ] && echo true)" "$n"
P -c "update app_settings set value = 'false' where key = 'hide_demo_clubs'" >/dev/null
x=$(pc); rep "L9 switch back off (rollback of the switch): postcheck all ok" "$([ -z "$x" ] && echo true)" "$x"
P -c "update app_settings set value = 'true' where key = 'hide_demo_clubs'" -c "drop policy \"clubs: read\" on clubs" -c "create policy \"clubs: read\" on clubs for select using (true)" >/dev/null
x=$(pc); rep "L10 postcheck catches a read policy that ignores the switch" "$([ -n "$x" ] && echo true)" "$x"
$PSQL -q -d postgres -c "drop database if exists $DB" >/dev/null
echo "summary: $oks ok, $fails FAIL"; [ $fails = 0 ] && echo "RESULT: PASS" || { echo "RESULT: FAIL"; exit 1; }
