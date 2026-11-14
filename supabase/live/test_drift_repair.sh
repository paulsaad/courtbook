#!/usr/bin/env bash
# LOCAL TEST ONLY. Builds a copy of the live drift with live's ids (0001–0064, demo club with live's
# id, the drift from test_make_live_replica.sql, coach Bol's exception) and runs drift_repair.sql
# against it in every case reviewed on 2026-11-14, including a concurrent insert.
# Usage: PSQL="sudo -u postgres psql" bash supabase/live/test_drift_repair.sh
set -u
cd "$(dirname "$0")/../.."
P=${PSQL:-psql}; D=drift_replica; F=supabase/live/drift_repair.sql
$P -q -c "drop database if exists ${D}_t" -c "drop database if exists race" -c "drop database if exists $D" -c "create database $D" >/dev/null
$P -q -d $D -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql >/dev/null
for f in $(ls supabase/migrations/0*.sql | sort); do n=$(basename "$f"); [ "${n%%_*}" \> "0064" ] && continue
  $P -q -d $D -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null 2>&1 || { echo "migration failed: $n"; exit 1; }; done
$P -q -d $D -c "insert into clubs (id, name, slug, location_url, slot_minutes, cancel_cutoff_hours, open_time, close_time, min_booking_minutes, max_booking_minutes, is_demo) values ('e73352f9-6ea1-4f97-b2f8-0b8bc26abdc0','Batroun Padel & Tennis Club','batroun','https://maps.google.com/?q=Batroun',30,6,'08:00','23:00',60,180,true)" >/dev/null
$P -q -d $D -f supabase/seed.sql >/dev/null 2>&1
$P -q -d $D -v ON_ERROR_STOP=1 -f supabase/live/test_make_live_replica.sql >/dev/null 2>&1
$P -q -d $D >/dev/null <<'SQL'
insert into auth.users (id, email) values ('2b2b0000-0000-4000-8000-0000000000b0','bol@courtbook.test');
update profiles set name='Bol' where id='2b2b0000-0000-4000-8000-0000000000b0';
insert into coaches (id, profile_id, sports, price_usd) values ('19d1d3bf-ddbc-4c0a-b17c-280bd96b31b6','2b2b0000-0000-4000-8000-0000000000b0','{padel}',20);
insert into coach_clubs (coach_id, club_id, status, requested_at, decided_at) values ('19d1d3bf-ddbc-4c0a-b17c-280bd96b31b6','e73352f9-6ea1-4f97-b2f8-0b8bc26abdc0','removed','2026-11-10 13:33','2026-11-10 13:56');
insert into availability_rules (coach_id, club_id, weekday, start_time, end_time) values ('19d1d3bf-ddbc-4c0a-b17c-280bd96b31b6','e73352f9-6ea1-4f97-b2f8-0b8bc26abdc0',1,'17:00','20:00'),('19d1d3bf-ddbc-4c0a-b17c-280bd96b31b6','e73352f9-6ea1-4f97-b2f8-0b8bc26abdc0',3,'17:00','20:00');
insert into availability_exceptions (id, coach_id, date, start_time, end_time, available) values ('1aedac0e-ee88-4b9a-a837-fdc038452abf','19d1d3bf-ddbc-4c0a-b17c-280bd96b31b6','2026-11-19',null,null,false);
SQL
v1=$($P -At -d $D -f supabase/live/0065_preflight.sql | awk -F'|' '$NF=="f"{print $2}' | paste -sd, -)
echo "replica: original preflight fails on: $v1"
q() { $P -At -d "$1" -c "$2" 2>&1; }
state() { echo "trigger=$(q $1 "select count(*) from pg_trigger where tgname='bookings_slot_validation'") club_id=$(q $1 "select count(*) from information_schema.columns where table_name='availability_exceptions' and column_name='club_id'") exceptions=$(q $1 "select count(*) || ' ' || string_agg(e.date::text || coalesce(' at ' || left(to_jsonb(e)->>'club_id', 8), ' no club'), ', ' order by e.date) from availability_exceptions e")"; }
run() { $P -q -c "drop database if exists ${D}_t" -c "create database ${D}_t template $D" >/dev/null 2>&1; [ -n "${2:-}" ] && $P -q -d ${D}_t -c "$2" >/dev/null 2>&1
  printf '%-48s %s | %s\n' "$3" "$($P -d ${D}_t -v ON_ERROR_STOP=1 -f "$1" 2>&1 | grep -oE 'ERROR:.*|drift repaired.*' | head -1)" "$(state ${D}_t)"; }
sed 's/$/\r/' $F > /tmp/repair_crlf.sql
run /tmp/repair_crlf.sql "" "normal run (Windows line endings)"
echo "  preflight v2 after it: $($P -At -d ${D}_t -f supabase/live/0065_preflight_v2.sql | awk -F'|' '{c[$NF]++} END{print c["t"]+0 " true, " c["f"]+0 " false"}')"
printf '%-48s %s\n' "second run" "$($P -d ${D}_t -f $F 2>&1 | grep -oE 'ERROR:.*' | head -1)"
run $F "update availability_exceptions set date='2026-11-20'" "exception differs from the reviewed one"
run $F "insert into availability_exceptions (coach_id, date, available) values ('19d1d3bf-ddbc-4c0a-b17c-280bd96b31b6','2026-11-26',false)" "a second exception exists before the repair"
run $F "delete from coach_clubs" "coach no longer linked to the club"
run $F "create trigger bookings_slot_validation before insert or update of court_id, start_at, end_at on bookings for each row execute function bookings_validate_slot()" "trigger already present"
python3 - "$F" <<'PY'
import sys; s=open(sys.argv[1]).read(); i=s.index("do $post$")
open('/tmp/repair_badpost.sql','w').write(s[:i]+s[i:].replace("e73352f9-6ea1-4f97-b2f8-0b8bc26abdc0","00000000-0000-4000-8000-000000000000"))
s2=s.replace("-- the column first (0023's own first statement","select pg_sleep(3);  -- TEST ONLY: window after the checks\n-- the column first (0023's own first statement",1)
open('/tmp/repair_race.sql','w').write(s2)
PY
run /tmp/repair_badpost.sql "" "a final check fails (forced)"
# concurrent insert while the repair is between its checks and 0023
$P -q -c "drop database if exists race" -c "create database race template $D" >/dev/null 2>&1
T0=$(date +%s); $P -d race -v ON_ERROR_STOP=1 -f /tmp/repair_race.sql > /tmp/race_a.log 2>&1 & sleep 1.2
b=$($P -At -d race -c "insert into availability_exceptions (coach_id, date, available) values ('19d1d3bf-ddbc-4c0a-b17c-280bd96b31b6','2026-11-26',false) returning 'inserted and committed'" 2>&1 | grep -oE 'ERROR:.*|inserted.*'); t=$(( $(date +%s) - T0 )); wait
printf '%-48s %s | insert (waited %ss): %s | %s\n' "concurrent insert during the repair" "$(grep -oE 'ERROR:.*|drift repaired.*' /tmp/race_a.log | head -1)" "$t" "$b" "$(state race)"
# another session holding a write lock: the repair gives up after 5 s
$P -q -c "drop database if exists race" -c "create database race template $D" >/dev/null 2>&1
( $P -q -d race -c "begin; delete from availability_exceptions where false; select pg_sleep(8); commit;" >/dev/null 2>&1 & ); sleep 0.5
printf '%-48s %s\n' "table busy in another session" "$($P -d race -v ON_ERROR_STOP=1 -f $F 2>&1 | grep -oE 'ERROR:.*|drift repaired.*' | head -1)"; sleep 8
echo "  state after: $(state race)"
