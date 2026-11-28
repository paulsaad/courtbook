#!/usr/bin/env bash
# The 0100 preflight STOPs on each kind of bad data, and only on that row (re-review of the 0.5.0 candidate, should-fix 1).
# LOCAL ONLY: its own scratch database (0001–0099 + seed); every case runs in a rolled-back transaction.
#   PSQL="sudo -u postgres psql" bash supabase/tests/sports/preflight_0100.sh
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
DB=courtbook_pf0100
$PSQL -q -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null 2>&1 || exit 2
trap '$PSQL -q -d postgres -c "drop database if exists $DB" >/dev/null 2>&1' EXIT
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql >/dev/null 2>&1 || exit 2
for f in $(ls supabase/migrations/*.sql | sort | awk -F/ '$NF < "0100"'); do $PSQL -q -d $DB -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null 2>&1 || { echo "BUILD FAILED: $f"; exit 2; }; done
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -f supabase/seed.sql >/dev/null 2>&1 || exit 2
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -c "insert into auth.users (id, phone) values ('d0000000-0000-4000-8000-0000000000d1', '+96170000901')" >/dev/null || exit 2
status=0
# $1 name, $2 the row that must STOP ('' = none), $3 bad data (SQL, inside the transaction)
case_() {
  local out stops
  out=$({ echo "begin;"; echo "$3"; echo "\\i supabase/live/sports_0100_preflight.sql"; echo "rollback;"; } | $PSQL -d $DB -X -q -At -F'|' -v ON_ERROR_STOP=1 2>&1)
  if echo "$out" | grep -q ERROR; then echo "FAIL $1 (error: $(echo "$out" | grep -m1 ERROR))"; status=1; return; fi
  stops=$(echo "$out" | awk -F'|' '$NF == "STOP" { split($1, a, " "); print a[1] }' | paste -sd, -)
  if [ "$stops" = "$2" ]; then echo "ok   $1 (STOP: ${stops:-none})"; else echo "FAIL $1: expected STOP on '${2:-none}', got '${stops:-none}'"; status=1; fi
}
case_ "P0 clean data: every row OK" "" "select 1;"
case_ "P1 an enum value outside the code format" "S2b" "alter type sport add value 'Beach';"
case_ "P2 a court of a sport missing from the catalogue" "S3" "delete from sports where code = 'badminton'; insert into courts (club_id, name, sport) select id, 'B1', 'badminton' from clubs where slug = 'batroun';"
case_ "P3 a profile lists an empty (NULL) sport" "S4" "update profiles set sports = '{padel,NULL}' where id = 'd0000000-0000-4000-8000-0000000000d1';"
case_ "P4 a coach lists an empty (NULL) sport" "S4" "insert into coaches (profile_id, sports) values ('d0000000-0000-4000-8000-0000000000d1', '{tennis,NULL}');"
case_ "P5 a sport name with a trailing space" "S5" "update sports set name_en = 'Squash ' where code = 'squash';"
case_ "P6 a blank sport name" "S5" "update sports set name_en = '' where code = 'squash';"
case_ "P7 two sports whose names differ only in case" "S6" "update sports set name_en = 'PADEL' where code = 'tennis';"
case_ "P8 another sport already called Table tennis" "S7" "update sports set name_en = 'Table Tennis' where code = 'squash';"
case_ "P9 discovery's search text changed since 0078" "S8" "do \$x\$ begin execute replace(pg_get_functiondef('club_discovery(sport,text,text,text)'::regprocedure), 't.name_ar like', 't.name_ar ilike'); end \$x\$;"
case_ "P10 a profile code not in the catalogue is information only (no STOP)" "" "delete from sports where code = 'volleyball'; update profiles set sports = '{volleyball}' where id = 'd0000000-0000-4000-8000-0000000000d1';"
[ $status = 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"
exit $status
