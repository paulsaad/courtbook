#!/usr/bin/env bash
# D3 (0071) at exact moments, Beirut time: a disposable LOCAL PostgreSQL cluster (port 5433, own socket
# directory) runs under libfaketime, so now() is a chosen instant: an ordinary afternoon, the 2-hour
# boundary to within 30 seconds, local midnight, and both nights Beirut's clocks change.
# Prints id|pass|detail lines. Needs libfaketime (FAKETIME_LIB); exits 3 if it is missing.
#   FAKETIME_LIB=/path/libfaketime.so.1 bash supabase/tests/fixes/d3_time.sh
# CONTROL=1 re-creates staff_book and move_booking without the lines marked "-- 0071" (= the pre-0071
# functions, see docs/audit/fixes.md); every check that guards D3 must then fail.
set -u
cd "$(dirname "$0")/../../.."
LIB=${FAKETIME_LIB:-/tmp/ft/libfaketime/src/libfaketime-time64.so.1}
[ -r "$LIB" ] || { echo "SKIP d3_time: libfaketime not found ($LIB)"; exit 3; }
PGBIN=${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)}
D=/tmp/courtbook_fixes_ft
FT="sudo -u postgres psql -h $D -p 5433 -X -q -At"
start() { sudo -u postgres env LD_PRELOAD="$LIB" FAKETIME="@$1" TZ=UTC "$PGBIN/pg_ctl" -D $D/data -o "-p 5433 -k $D -c listen_addresses=''" -l $D/log -w start >/dev/null; }
stop()  { sudo -u postgres "$PGBIN/pg_ctl" -D $D/data -m fast -w stop >/dev/null 2>&1 || true; }
trap 'stop; sudo rm -rf $D' EXIT
stop; sudo rm -rf $D; sudo mkdir -p $D; sudo chown postgres $D
sudo -u postgres "$PGBIN/initdb" -D $D/data -A trust -U postgres >/dev/null || exit 1
start "2027-11-17 10:00:00"
PSQL="sudo -u postgres psql -h $D -p 5433" DB=courtbook_fixes_time bash supabase/tests/audit/build_db.sh WORKTREE >/dev/null || { echo "FAIL build on the faked-clock cluster"; exit 1; }
# fixture: one staff member at the demo club; the club open around the clock (midnight cases)
$FT -d courtbook_fixes_time -v ON_ERROR_STOP=1 <<'SQL' >/dev/null || exit 1
insert into auth.users (id, email) values ('f3000000-0000-4000-8000-0000000000b1', 'd3-sa@fix.test');
insert into club_staff (club_id, profile_id) select id, 'f3000000-0000-4000-8000-0000000000b1' from clubs where slug = 'batroun';
update clubs set open_time = '00:00', close_time = '24:00' where slug = 'batroun';
insert into price_rules (club_id, court_id, weekday_mask, start_time, end_time, price_usd, label)
  select id, null, 127, '00:00', '08:00', 20, 'night' from clubs where slug = 'batroun';
insert into price_rules (club_id, court_id, weekday_mask, start_time, end_time, price_usd, label)
  select id, null, 127, '23:00', '24:00', 20, 'late' from clubs where slug = 'batroun';
SQL
if [ -n "${CONTROL:-}" ]; then
  grep -v -- '-- 0071' supabase/migrations/0071_staff_past_times.sql | $FT -d courtbook_fixes_time -v ON_ERROR_STOP=1 >/dev/null || exit 1
  # 0091 and F1 (staff moves check what the desk saw) carry the same guard lines (marked "-- 0071") in
  # move_booking_priced, which the moves now use: re-create each of them, in order, without those lines
  for m in $(grep -l 'move_booking_priced' supabase/migrations/*.sql | sort); do
    grep -v -- '-- 0071' "$m" | $FT -d courtbook_fixes_time -v ON_ERROR_STOP=1 >/dev/null || exit 1
  done
  echo "CONTROL: 0071 guard lines removed"
fi
stop

# scenario <fake UTC start> <label> <<SQL — runs SQL as the staff member in a rolled-back transaction
scenario() {
  start "$1"
  { cat <<'HEAD'
\set ON_ERROR_STOP 1
begin;
create temp table r (id text, pass boolean, detail text);
grant all on r to authenticated;
create function pg_temp.err(q text) returns text language plpgsql as $f$
begin execute q; return 'no error'; exception when others then return sqlerrm; end $f$;
create function pg_temp.l(t text) returns timestamptz language sql as $f$ select t::timestamp at time zone 'Asia/Beirut' $f$;
grant execute on function pg_temp.err(text), pg_temp.l(text) to public;
create function pg_temp.walk(court text, s timestamptz, e timestamptz, who text) returns text language sql as $f$
  select pg_temp.err(format('select staff_book((select id from clubs where slug = %L), (select id from courts where name = %L), %L, %L, %L, null)',
                            'batroun', court, s, e, who)) $f$;
-- 0091: a walk-in's move may change its price, so the desk confirms the new price (move_booking_priced); the
-- expected price is the club's price for the target (null if it has none, then the move's own checks answer)
create function pg_temp.qp(court text, s timestamptz, e timestamptz) returns numeric language plpgsql as $f$
begin return quote_price((select id from courts where name = court), s, e); exception when others then return null; end $f$;
create function pg_temp.mv(who text, court text, s timestamptz, e timestamptz) returns text language sql as $f$
  -- F1: the 8-argument call, with what the desk sees now (the booking's current court and time)
  select pg_temp.err(format('select move_booking_priced((select id from bookings where guest_name = %1$L), (select id from courts where name = %2$L), %3$L, %4$L, %5$s, '
                            '(select court_id from bookings where guest_name = %1$L), (select start_at from bookings where guest_name = %1$L), (select end_at from bookings where guest_name = %1$L))',
                            who, court, s, e, coalesce(pg_temp.qp(court, s, e)::text, 'null'))) $f$;
grant execute on function pg_temp.walk(text, timestamptz, timestamptz, text), pg_temp.mv(text, text, timestamptz, timestamptz), pg_temp.qp(text, timestamptz, timestamptz) to public;
-- chk(id, what happened, what should happen): each action runs once, its result is the detail
create function pg_temp.chk(id text, got text, expected text) returns void language sql as $f$
  insert into r values (id, got = expected, got) $f$;
grant execute on function pg_temp.chk(text, text, text) to public;
-- fixture bookings are written directly (as the database owner), the way the desk would have entered them
create function pg_temp.fix(who text, court text, s timestamptz, e timestamptz) returns void language sql as $f$
  insert into bookings (club_id, court_id, guest_name, start_at, end_at, status, source, created_by, price_usd, fee_usd)
  select k.club_id, k.id, who, s, e, 'confirmed', 'staff', 'f3000000-0000-4000-8000-0000000000b1', 20, 0
  from courts k join clubs c on c.id = k.club_id where c.slug = 'batroun' and k.name = court $f$;
HEAD
    cat
    cat <<'TAIL'
select id || '|' || coalesce(pass::text, 'f') || '|' || coalesce(detail, '') from r order by id;
rollback;
TAIL
  } | $FT -d courtbook_fixes_time 2>&1
  stop
}
AS_STAFF="set role authenticated; select set_config('request.jwt.claim.sub', 'f3000000-0000-4000-8000-0000000000b1', false) \\g /dev/null"

# ---- ordinary weekday: now = Wed 17 Nov 2027 12:09:30 Beirut (UTC+2) = 10:09:30Z
scenario "2027-11-17 10:09:30" <<SQL
insert into r select 'D3-T0 clock: now is 12:09 in Beirut, UTC+2', to_char(now() at time zone 'Asia/Beirut', 'HH24:MI') = '12:09', to_char(now() at time zone 'Asia/Beirut', 'YYYY-MM-DD HH24:MI:SS');
select pg_temp.fix('Future', 'Padel 1', pg_temp.l('2027-11-17 15:00'), pg_temp.l('2027-11-17 16:00'));
select pg_temp.fix('Playing', 'Padel 3', pg_temp.l('2027-11-17 11:30'), pg_temp.l('2027-11-17 12:30'));
select pg_temp.fix('Done', 'Padel 2', pg_temp.l('2027-11-17 08:00'), pg_temp.l('2027-11-17 09:00'));
select pg_temp.fix('Occupant', 'Padel 2', pg_temp.l('2027-11-17 11:00'), pg_temp.l('2027-11-17 12:00'));
select pg_temp.fix('Later', 'Padel 2', pg_temp.l('2027-11-17 12:00'), pg_temp.l('2027-11-17 13:00'));
$AS_STAFF
select pg_temp.chk('D3-W1 walk-in that started 1 h 40 ago (10:30) is accepted', pg_temp.walk('Padel 1', pg_temp.l('2027-11-17 10:30'), pg_temp.l('2027-11-17 11:30'), 'W1'), 'no error');
select pg_temp.chk('D3-W2 walk-in that started 2 h 10 ago (10:00) is refused', pg_temp.walk('Tennis 1', pg_temp.l('2027-11-17 10:00'), pg_temp.l('2027-11-17 11:00'), 'W2'), 'walk_in_too_old');
select pg_temp.chk('D3-W3 a later booking today is accepted', pg_temp.walk('Tennis 1', pg_temp.l('2027-11-17 14:00'), pg_temp.l('2027-11-17 15:00'), 'W3'), 'no error');
select pg_temp.chk('D3-W4 a recent walk-in onto a taken court still gets slot_taken', pg_temp.walk('Padel 2', pg_temp.l('2027-11-17 10:30'), pg_temp.l('2027-11-17 11:30'), 'W4'), 'slot_taken');
select pg_temp.chk('D3-W5 ...and off-grid or outside-hours rules still apply inside the window', pg_temp.walk('Tennis 2', pg_temp.l('2027-11-17 10:40'), pg_temp.l('2027-11-17 11:40'), 'W5'), 'not_on_grid');
select pg_temp.chk('D3-M1 a future booking cannot be moved to 11:00 today (passed)', pg_temp.mv('Future', 'Padel 1', pg_temp.l('2027-11-17 11:00'), pg_temp.l('2027-11-17 12:00')), 'move_into_past');
select pg_temp.chk('D3-M2 ...but can be moved later today', pg_temp.mv('Future', 'Padel 1', pg_temp.l('2027-11-17 16:00'), pg_temp.l('2027-11-17 17:00')), 'no error');
select pg_temp.chk('D3-M3 a booking being played can change court, keeping its start', pg_temp.mv('Playing', 'Padel 1', pg_temp.l('2027-11-17 11:30'), pg_temp.l('2027-11-17 12:30')), 'no error');
select pg_temp.chk('D3-M4 ...and be extended', pg_temp.mv('Playing', 'Padel 1', pg_temp.l('2027-11-17 11:30'), pg_temp.l('2027-11-17 13:00')), 'no error');
select pg_temp.chk('D3-M5 ...but its start cannot move earlier', pg_temp.mv('Playing', 'Padel 1', pg_temp.l('2027-11-17 11:00'), pg_temp.l('2027-11-17 12:30')), 'move_into_past');
select pg_temp.chk('D3-M6 ...nor can it be cut to end before now', pg_temp.mv('Playing', 'Padel 1', pg_temp.l('2027-11-17 11:30'), pg_temp.l('2027-11-17 12:00')), 'move_into_past');
select pg_temp.chk('D3-M7 ...and moving it onto a taken court still gets slot_taken', pg_temp.mv('Playing', 'Padel 2', pg_temp.l('2027-11-17 11:30'), pg_temp.l('2027-11-17 13:00')), 'slot_taken');
select pg_temp.chk('D3-M8 a booking that already ended cannot change court', pg_temp.mv('Done', 'Padel 3', pg_temp.l('2027-11-17 08:00'), pg_temp.l('2027-11-17 09:00')), 'booking_ended');
select pg_temp.chk('D3-M9 ...nor be moved to a future time', pg_temp.mv('Done', 'Padel 3', pg_temp.l('2027-11-17 18:00'), pg_temp.l('2027-11-17 19:00')), 'booking_ended');
reset role;
insert into r select 'D3-M10 after all moves: Playing on Padel 1 11:30-13:00, Future 16:00-17:00, no overlap',
  (select string_agg(guest_name || ' ' || to_char(start_at at time zone 'Asia/Beirut', 'HH24:MI') || '-' || to_char(end_at at time zone 'Asia/Beirut', 'HH24:MI'), ', ' order by start_at)
   from bookings b join courts k on k.id = b.court_id where k.name = 'Padel 1' and b.status = 'confirmed') = 'W1 10:30-11:30, Playing 11:30-13:00, Future 16:00-17:00',
  (select string_agg(guest_name || ' ' || to_char(start_at at time zone 'Asia/Beirut', 'HH24:MI') || '-' || to_char(end_at at time zone 'Asia/Beirut', 'HH24:MI'), ', ' order by start_at)
   from bookings b join courts k on k.id = b.court_id where k.name = 'Padel 1' and b.status = 'confirmed');
SQL

# ---- the 2-hour boundary, to within 30 s: 10:30 local (08:30Z)
scenario "2027-11-17 10:29:30" <<SQL
$AS_STAFF
select pg_temp.chk('D3-B1 at 12:29:30 a walk-in from 10:30 (1 h 59 m 30 s ago) is accepted', pg_temp.walk('Padel 1', pg_temp.l('2027-11-17 10:30'), pg_temp.l('2027-11-17 11:30'), 'B1'), 'no error');
SQL
scenario "2027-11-17 10:30:30" <<SQL
$AS_STAFF
select pg_temp.chk('D3-B2 at 12:30:30 the same walk-in (2 h 0 m 30 s ago) is refused', pg_temp.walk('Padel 1', pg_temp.l('2027-11-17 10:30'), pg_temp.l('2027-11-17 11:30'), 'B2'), 'walk_in_too_old');
SQL

# ---- the end of a booking, to within 30 s: "Hour" is 10:00-11:00 local (08:00-09:00Z) on Padel 3
scenario "2027-11-17 08:59:30" <<SQL
select pg_temp.fix('Hour', 'Padel 3', pg_temp.l('2027-11-17 10:00'), pg_temp.l('2027-11-17 11:00'));
$AS_STAFF
select pg_temp.chk('D3-E1 at 10:59:30 the booking is still being played: it can change court', pg_temp.mv('Hour', 'Padel 1', pg_temp.l('2027-11-17 10:00'), pg_temp.l('2027-11-17 11:00')), 'no error');
select pg_temp.chk('D3-E2 ...and be extended', pg_temp.mv('Hour', 'Padel 1', pg_temp.l('2027-11-17 10:00'), pg_temp.l('2027-11-17 11:30')), 'no error');
SQL
scenario "2027-11-17 09:00:30" <<SQL
select pg_temp.fix('Hour', 'Padel 3', pg_temp.l('2027-11-17 10:00'), pg_temp.l('2027-11-17 11:00'));
$AS_STAFF
select pg_temp.chk('D3-E3 at 11:00:30 it has ended: changing court is refused', pg_temp.mv('Hour', 'Padel 1', pg_temp.l('2027-11-17 10:00'), pg_temp.l('2027-11-17 11:00')), 'booking_ended');
select pg_temp.chk('D3-E4 ...extending is refused', pg_temp.mv('Hour', 'Padel 3', pg_temp.l('2027-11-17 10:00'), pg_temp.l('2027-11-17 11:30')), 'booking_ended');
select pg_temp.chk('D3-E5 ...and moving it to a free later time is refused', pg_temp.mv('Hour', 'Padel 3', pg_temp.l('2027-11-17 15:00'), pg_temp.l('2027-11-17 16:00')), 'booking_ended');
reset role;
insert into r select 'D3-E6 ...and it is still where it was', (select to_char(start_at at time zone 'Asia/Beirut', 'HH24:MI') || '-' || to_char(end_at at time zone 'Asia/Beirut', 'HH24:MI') || ' ' || k.name
  from bookings b join courts k on k.id = b.court_id where guest_name = 'Hour') = '10:00-11:00 Padel 3',
  (select to_char(start_at at time zone 'Asia/Beirut', 'HH24:MI') || '-' || to_char(end_at at time zone 'Asia/Beirut', 'HH24:MI') || ' ' || k.name from bookings b join courts k on k.id = b.court_id where guest_name = 'Hour');
SQL

# ---- just after local midnight: now = Thu 18 Nov 00:49:30 Beirut = 22:49:30Z Wed
scenario "2027-11-17 22:49:30" <<SQL
insert into r select 'D3-N0 clock: now is 00:49 on Thursday in Beirut', to_char(now() at time zone 'Asia/Beirut', 'Dy HH24:MI') = 'Thu 00:49', to_char(now() at time zone 'Asia/Beirut', 'Dy HH24:MI');
select pg_temp.fix('Night', 'Padel 3', pg_temp.l('2027-11-18 00:00'), pg_temp.l('2027-11-18 01:00'));
$AS_STAFF
select pg_temp.chk('D3-N1 a walk-in from 23:00 the previous day (1 h 49 ago) is accepted', pg_temp.walk('Padel 1', pg_temp.l('2027-11-17 23:00'), pg_temp.l('2027-11-18 00:00'), 'N1'), 'no error');
select pg_temp.chk('D3-N2 a walk-in from 22:30 the previous day (2 h 19 ago) is refused', pg_temp.walk('Tennis 1', pg_temp.l('2027-11-17 22:30'), pg_temp.l('2027-11-17 23:30'), 'N2'), 'walk_in_too_old');
select pg_temp.chk('D3-N3 the booking being played since midnight can change court', pg_temp.mv('Night', 'Tennis 2', pg_temp.l('2027-11-18 00:00'), pg_temp.l('2027-11-18 01:00')), 'no error');
select pg_temp.chk('D3-N4 ...but cannot be moved back to 23:00 the previous day', pg_temp.mv('Night', 'Tennis 2', pg_temp.l('2027-11-17 23:00'), pg_temp.l('2027-11-18 00:00')), 'move_into_past');
SQL

# ---- clocks go back: Sun 31 Oct 2027 00:00 (UTC+3) becomes Sat 23:00 (UTC+2); 23:00-24:00 Saturday
#      happens twice. now = 21:39:30Z = 23:39:30 local, second time round. Times given in UTC.
scenario "2027-10-30 21:39:30" <<SQL
insert into r select 'D3-F0 clock: 23:39 local, second pass (UTC+2); 20:00Z was 23:00 first pass (UTC+3)',
  to_char(now() at time zone 'Asia/Beirut', 'HH24:MI') = '23:39'
  and to_char(timestamptz '2027-10-30 20:00+00' at time zone 'Asia/Beirut', 'HH24:MI') = '23:00'
  and extract(epoch from (now() at time zone 'Asia/Beirut') - now() at time zone 'UTC') = 7200, '';
$AS_STAFF
select pg_temp.chk('D3-F1 walk-in at 23:00 first pass (20:00Z, 1 h 39 real ago) is accepted', pg_temp.walk('Padel 1', '2027-10-30 20:00+00', '2027-10-30 21:00+00', 'F1'), 'no error');
select pg_temp.chk('D3-F2 walk-in at 22:30 (19:30Z, 2 h 09 real ago) is refused', pg_temp.walk('Padel 3', '2027-10-30 19:30+00', '2027-10-30 20:30+00', 'F2'), 'walk_in_too_old');
select pg_temp.chk('D3-F3 walk-in at 23:00 second pass (21:00Z, 39 min ago) is accepted', pg_temp.walk('Tennis 1', '2027-10-30 21:00+00', '2027-10-30 22:00+00', 'F3'), 'no error');
SQL

# ---- clocks go forward: Sun 26 Mar 2028 00:00 (UTC+2) becomes 01:00 (UTC+3).
#      now = 22:29:30Z = 01:29:30 local Sunday. Saturday 22:30 local (20:30Z) was 1 h 59 m 30 s ago in
#      real time, although the wall clock shows almost 3 hours.
scenario "2028-03-25 22:29:30" <<SQL
insert into r select 'D3-S0 clock: Sunday 01:29 local (UTC+3); Saturday 22:30 local was UTC+2',
  to_char(now() at time zone 'Asia/Beirut', 'Dy HH24:MI') = 'Sun 01:29'
  and pg_temp.l('2028-03-25 22:30') = timestamptz '2028-03-25 20:30+00', to_char(now() at time zone 'Asia/Beirut', 'Dy HH24:MI');
$AS_STAFF
select pg_temp.chk('D3-S1 walk-in from Saturday 22:30 (2 h 59 on the wall clock, 1 h 59 m 30 s real) is accepted',
  pg_temp.walk('Padel 1', pg_temp.l('2028-03-25 22:30'), pg_temp.l('2028-03-25 23:30'), 'S1'), 'no error');
select pg_temp.chk('D3-S2 walk-in from Saturday 22:00 (2 h 29 real) is refused', pg_temp.walk('Padel 3', pg_temp.l('2028-03-25 22:00'), pg_temp.l('2028-03-25 23:00'), 'S2'), 'walk_in_too_old');
SQL

# ---- two desks enter the same recent walk-in at the same moment (committed, in a scratch copy)
start "2027-11-17 10:09:30"
sudo -u postgres psql -h $D -p 5433 -q -d postgres -c "drop database if exists courtbook_fixes_time_race" -c "create database courtbook_fixes_time_race template courtbook_fixes_time" >/dev/null
RACE="sudo -u postgres psql -h $D -p 5433 -X -q -At -d courtbook_fixes_time_race"
$RACE -c "insert into auth.users (id, email) values ('f3000000-0000-4000-8000-0000000000b2', 'd3-sb@fix.test'); insert into club_staff (club_id, profile_id) select id, 'f3000000-0000-4000-8000-0000000000b2' from clubs where slug = 'batroun';" >/dev/null
desk() { printf "%s\n" "set role authenticated; select set_config('request.jwt.claim.sub', '$1', false) \\g /dev/null" \
  "begin; select staff_book((select id from clubs where slug = 'batroun'), (select id from courts where name = 'Padel 1'), '2027-11-17 08:30+00', '2027-11-17 09:30+00', '$2', null) \\g /dev/null" \
  "select pg_sleep($3); commit;" | $RACE 2>&1 | grep -o "ERROR: .*" | head -1 | grep . || echo "no error"; }
desk f3000000-0000-4000-8000-0000000000b1 DeskA 1.5 > /tmp/d3race.a & sleep 0.4
desk f3000000-0000-4000-8000-0000000000b2 DeskB 0 > /tmp/d3race.b; wait
n=$($RACE -c "select count(*) from bookings b join courts k on k.id = b.court_id where k.name = 'Padel 1' and b.status = 'confirmed' and b.start_at = '2027-11-17 08:30+00'")
ea=$(cat /tmp/d3race.a); eb=$(cat /tmp/d3race.b)
echo "D3-R1 two desks enter the same recent walk-in at once: one booking, the second desk gets slot_taken|$([ "$n" = 1 ] && [ "$ea" = "no error" ] && echo "$eb" | grep -q slot_taken && echo true || echo false)|bookings $n; A: $ea; B: $eb"
sudo -u postgres psql -h $D -p 5433 -q -d postgres -c "drop database courtbook_fixes_time_race" >/dev/null
stop
