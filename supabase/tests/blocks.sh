#!/usr/bin/env bash
# Calendar blocks, migrations 0076 + 0077: rules, overlap and locking, and the rollout in its real order.
#   stage 0  database at 0075 (today's live and staging)
#   stage A  0076 applied, the old website (direct inserts) still in use
#   stage B  0077 applied, the new website (staff_block) only
#   then     both migrations re-applied; both rollbacks
# Each check prints ok/FAIL; the script exits 1 on any failure.
# Usage: PSQL="psql -U postgres" supabase/tests/blocks.sh
set -u
cd "$(dirname "$0")/../.."
PSQL=${PSQL:-psql}
DB=courtbook_blocks
P="$PSQL -X -q -At -d $DB"

$PSQL -q -c "drop database if exists $DB" -c "create database $DB" >/dev/null
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql >/dev/null || exit 1
for f in $(ls supabase/migrations/*.sql | sort); do
  case $(basename "$f") in 0076_*|0077_*) continue;; esac
  $PSQL -q -d $DB -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null 2>&1 || { echo "MIGRATION FAILED: $f"; exit 1; }
done
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -f supabase/seed.sql >/dev/null || exit 1

P1=11111111-1111-1111-1111-111111111111      # player
ADMIN=33333333-3333-3333-3333-333333333333   # CourtBook admin
DESK=55555555-5555-5555-5555-555555555555    # desk staff of the demo club (Beirut)
DESK_T=66666666-6666-6666-6666-666666666666  # desk staff of a Tokyo club only
$P -v ON_ERROR_STOP=1 >/dev/null <<SQL
insert into auth.users (id, phone) values ('$P1','+9611'), ('$ADMIN','+9613'), ('$DESK','+9615'), ('$DESK_T','+9616');
update profiles set roles='{player,admin}' where id='$ADMIN';
insert into club_staff (club_id, profile_id) select id, '$DESK' from clubs where slug='batroun';
-- Tokyo: 60-minute grid, 07:00-22:00 local (UTC+9, Beirut is UTC+2/+3)
insert into clubs (name, slug, timezone, slot_minutes, open_time, close_time, min_booking_minutes, max_booking_minutes, payment_mode)
  values ('Tokyo Club', 'tokyo', 'Asia/Tokyo', 60, '07:00', '22:00', 60, 120, 'at_desk');
insert into courts (club_id, name, sport) select id, 'T1', 'padel' from clubs where slug='tokyo';
insert into club_staff (club_id, profile_id) select id, '$DESK_T' from clubs where slug='tokyo';
-- open all day, so "already started and still running" can be tested at any hour
insert into clubs (name, slug, timezone, slot_minutes, open_time, close_time, min_booking_minutes, max_booking_minutes, payment_mode)
  values ('Night Club', 'night', 'Asia/Beirut', 30, '00:00', '24:00', 60, 120, 'at_desk');
insert into courts (club_id, name, sport) select id, 'N1', 'padel' from clubs where slug='night';
insert into club_staff (club_id, profile_id) select id, '$DESK' from clubs where slug='night';
insert into price_rules (club_id, weekday_mask, start_time, end_time, price_usd) select id, 127, '00:00', '24:00', 20 from clubs where slug='night';   -- desk bookings there need a price (A9j)
insert into courts (club_id, name, sport, active) select id, 'Closed court', 'padel', false from clubs where slug='batroun';
SQL
CLUB=$($P -c "select id from clubs where slug='batroun'")
TOKYO=$($P -c "select id from clubs where slug='tokyo'")
NIGHT=$($P -c "select id from clubs where slug='night'")
C1=$($P -c "select id from courts where club_id='$CLUB' and name='Padel 1'")
C2=$($P -c "select id from courts where club_id='$CLUB' and name='Padel 2'")
C3=$($P -c "select id from courts where club_id='$CLUB' and name='Padel 3'")
C4=$($P -c "select id from courts where club_id='$CLUB' and name='Tennis 1'")
CX=$($P -c "select id from courts where club_id='$CLUB' and name='Closed court'")
T1=$($P -c "select id from courts where club_id='$TOKYO'")
N1=$($P -c "select id from courts where club_id='$NIGHT'")

FAILS=0; CHECKS=0
ok()  { CHECKS=$((CHECKS+1)); echo "  ok    $1"; }
bad() { CHECKS=$((CHECKS+1)); FAILS=$((FAILS+1)); echo "  FAIL  $1 — $2"; }
as() { case $1 in anon) echo "set role anon; select set_config('request.jwt.claim.sub','',false);";;
                  owner) echo "select 1 where false;";;
                  *) echo "set role authenticated; select set_config('request.jwt.claim.sub','$1',false);";; esac; }
# result of one statement as a user: the last output line, or the error text after "ERROR:"
run() { local out; out=$({ as $1; echo "$2"; } | $P 2>&1 | grep -v "^$" | grep -v set_config)
  if echo "$out" | grep -q "^ERROR:"; then echo "$out" | grep -m1 "^ERROR:" | sed 's/^ERROR: *//'; else echo "$out" | tail -1; fi; }
expect() { local got; got=$(run "$1" "$3"); [ "$got" = "$4" ] && ok "$2" || bad "$2" "expected [$4] got [$got]"; }
expect_err() { local got; got=$(run "$1" "$3"); case "$got" in *"$4"*) ok "$2 ($4)";; *) bad "$2" "expected error [$4] got [$got]";; esac; }
b()  { echo "(current_date + $1 + time '$2') at time zone 'Asia/Beirut'"; }   # Beirut local day offset + time
tk() { echo "(current_date + $1 + time '$2') at time zone 'Asia/Tokyo'"; }
sb() { echo "select 'saved' from staff_block('$1','$2', $3, $4, 'test');"; }                         # new website
di() { echo "insert into blocks (club_id, court_id, start_at, end_at, reason, created_by) values ('$1','$2', $3, $4, 'old page', auth.uid()) returning 'saved';"; }  # old website
blocks_hash() { $P -c "select count(*)||':'||coalesce(md5(string_agg(id::text||court_id||club_id||start_at||end_at||coalesce(reason,'')||created_by||created_at, ',' order by id)),'-') from blocks where reason in ('kept','kept off-rule','kept past')"; }
pair() { # two connections: $2 starts 1 s after $1, which holds its transaction open 3 s
  { as $1; echo "begin;"; echo "$2"; echo "select pg_sleep(3); ${5:-commit};"; } | $P > /tmp/cbb_a.log 2>&1 &
  local pid=$!; sleep 1
  { as $3; echo "$4"; } | $P > /tmp/cbb_b.log 2>&1; wait $pid; }
clear_court() { $P -c "delete from payments where booking_id in (select id from bookings where court_id='$1'); delete from bookings where court_id='$1'; delete from blocks where court_id='$1' and reason not like 'kept%';" >/dev/null; }

# saved blocks that the migrations must not touch: a normal one, one the new rules would refuse, a past one
$P >/dev/null <<SQL
insert into blocks (club_id, court_id, start_at, end_at, reason, created_by) values
  ('$CLUB','$C4', $(b 30 10:00), $(b 30 12:00), 'kept', '$DESK'),
  ('$CLUB','$C4', $(b 31 14:15), $(b 31 15:05), 'kept off-rule', '$DESK'),
  ('$CLUB','$C4', $(b -3 10:00), $(b -3 11:00), 'kept past', '$DESK');
SQL
H0=$(blocks_hash)

echo "--- stage 0: database at 0075"
expect $DESK "0.1 old page: a valid block is saved"                           "$(di $CLUB $C1 "$(b 2 10:00)" "$(b 2 11:00)")" saved
expect $DESK "0.2 old page: an off-grid block is ALSO saved today (the gap)"  "$(di $CLUB $C1 "$(b 2 14:15)" "$(b 2 15:15)")" saved
clear_court $C1

echo "--- stage A: 0076 applied, old website still in use"
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -1 -f supabase/migrations/0076_staff_block.sql >/dev/null || { echo "0076 FAILED"; exit 1; }
[ "$(blocks_hash)" = "$H0" ] && ok "A0 saved blocks unchanged by 0076 (incl. one off-rule and one past)" || bad "A0 saved blocks changed" "$(blocks_hash) vs $H0"

echo "  permissions and court ownership"
expect_err anon    "A1 signed out"                                            "$(sb $CLUB $C1 "$(b 3 10:00)" "$(b 3 11:00)")" "permission denied for function staff_block"
expect_err $P1     "A2 a player"                                              "$(sb $CLUB $C1 "$(b 3 10:00)" "$(b 3 11:00)")" forbidden
expect_err $DESK_T "A3 staff of another club"                                 "$(sb $CLUB $C1 "$(b 3 10:00)" "$(b 3 11:00)")" forbidden
expect_err $DESK_T "A4 own club id with another club's court"                 "$(sb $TOKYO $C1 "$(b 3 10:00)" "$(b 3 11:00)")" court_not_found
expect_err $DESK   "A5 an inactive court of the club"                         "$(sb $CLUB $CX "$(b 3 10:00)" "$(b 3 11:00)")" court_not_found
expect     $ADMIN  "A6 CourtBook admin"                                       "$(sb $CLUB $C1 "$(b 3 10:00)" "$(b 3 11:00)")" saved
expect     $DESK   "A7 desk staff, full day 08:00-23:00 (beyond the old 4 h)" "$(sb $CLUB $C2 "$(b 3 08:00)" "$(b 3 23:00)")" saved
r=$($P -c "select reason from blocks where court_id='$C2' and start_at=$(b 3 08:00)"); [ "$r" = test ] && ok "A8 reason stored" || bad "A8 reason" "$r"
expect     $DESK   "A9 empty reason becomes 'Blocked'"                         "select staff_block('$CLUB','$C3', $(b 3 08:00), $(b 3 09:00), '  ') is not null; select reason from blocks where court_id='$C3' and start_at=$(b 3 08:00);" Blocked
expect     $DESK   "A9b ends exactly at closing time (22:30-23:00)"            "$(sb $CLUB $C1 "$(b 3 22:30)" "$(b 3 23:00)")" saved
clear_court $C1; clear_court $C2; clear_court $C3

echo "  midnight (a club closing at 24:00) and the two nights Beirut's clocks change"
# the next nights the clocks change, found from the time zone data (so this keeps working every year)
DAYLEN="((d + 1)::timestamp at time zone 'Asia/Beirut') - (d::timestamp at time zone 'Asia/Beirut')"
SPRING=$($P -c "select (d - 1)::date from generate_series(current_date + 1, current_date + 400, interval '1 day') g, lateral (select g::date as d) x where $DAYLEN < interval '24 hours' order by d limit 1")
FALL=$($P -c "select d from generate_series(current_date + 1, current_date + 400, interval '1 day') g, lateral (select g::date as d) x where $DAYLEN > interval '24 hours' order by d limit 1")
nb() { echo "('$1 $2'::timestamp at time zone 'Asia/Beirut')"; }        # a Beirut wall-clock time on a given date
mid() { echo "(('$1'::date + 1)::timestamp at time zone 'Asia/Beirut')"; } # the first instant of the next day
len() { $P -c "select (end_at - start_at)::text from blocks where court_id='$N1' order by created_at desc limit 1"; }
expect     $DESK   "A9c 22:00-24:00 on an ordinary day: ends at the next local midnight" "$(sb $NIGHT $N1 "$(b 6 22:00)" "$(b 7 00:00)")" saved
[ "$(len)" = "02:00:00" ] && ok "A9d ...2 hours" || bad "A9d" "$(len)"
expect_err $DESK   "A9e 23:30-00:30 runs past midnight: refused"               "$(sb $NIGHT $N1 "$(b 8 23:30)" "$(b 9 00:30)")" outside_opening_hours
expect     $DESK   "A9f clocks go back ($FALL): 22:00-24:00 saved"            "$(sb $NIGHT $N1 "$(nb $FALL 22:00)" "$(mid $FALL)")" saved
[ "$(len)" = "03:00:00" ] && ok "A9g ...as the 3 real hours of that wall-clock interval" || bad "A9g" "$(len)"
expect     $DESK   "A9h clocks go forward ($SPRING): 22:00-23:30 saved"       "$(sb $NIGHT $N1 "$(nb $SPRING 22:00)" "$(nb $SPRING 23:30)")" saved
# 0084: an end at the first instant of the next day is that day's 24:00, also on the spring night (fixed; was refused)
expect     $DESK   "A9i clocks go forward: 23:30-24:00 saved (0084: the night's midnight is the next day's first instant)" "$(sb $NIGHT $N1 "$(nb $SPRING 23:30)" "$(mid $SPRING)")" saved
clear_court $N1
expect_err $DESK   "A9j2 ...but nothing past it: 23:30-01:30 next day still refused" "$(sb $NIGHT $N1 "$(nb $SPRING 23:30)" "(('$SPRING'::date + 1)::timestamp + time '01:30') at time zone 'Asia/Beirut'")" outside_opening_hours
clear_court $N1
expect     $DESK   "A9j a desk booking 23:00-24:00 that night is taken (same rule for bookings)" "select 'booked' from staff_book('$NIGHT','$N1', $(nb $SPRING 23:00), $(mid $SPRING), 'W', null);" booked
clear_court $N1

echo "  grid and opening hours, in each club's own time zone"
expect_err $DESK   "A10 Beirut 07:30-08:30 (before opening)"                  "$(sb $CLUB $C1 "$(b 3 07:30)" "$(b 3 08:30)")" outside_opening_hours
expect_err $DESK   "A11 Beirut 22:30-23:30 (after closing)"                   "$(sb $CLUB $C1 "$(b 3 22:30)" "$(b 3 23:30)")" outside_opening_hours
expect_err $DESK   "A12 Beirut 22:00-01:00 (over midnight)"                   "$(sb $CLUB $C1 "$(b 3 22:00)" "$(b 4 01:00)")" outside_opening_hours
expect_err $DESK   "A13 Beirut three days"                                    "$(sb $CLUB $C1 "$(b 3 08:00)" "$(b 5 23:00)")" outside_opening_hours
expect_err $DESK   "A14 Beirut 14:15-15:15 (off the 30-min grid)"             "$(sb $CLUB $C1 "$(b 3 14:15)" "$(b 3 15:15)")" not_on_grid
expect_err $DESK   "A15 Beirut 15:00-15:45 (not whole slots)"                 "$(sb $CLUB $C1 "$(b 3 15:00)" "$(b 3 15:45)")" bad_duration
expect_err $DESK   "A16 Beirut 16:00:30-16:30:30 (seconds)"                   "$(sb $CLUB $C1 "$(b 3 16:00:30)" "$(b 3 16:30:30)")" not_on_grid
expect_err $DESK   "A17 end before start"                                     "$(sb $CLUB $C1 "$(b 3 12:00)" "$(b 3 11:00)")" bad_duration
expect     $DESK_T "A18 Tokyo 07:00-22:00 local (full day)"                   "$(sb $TOKYO $T1 "$(tk 3 07:00)" "$(tk 3 22:00)")" saved
clear_court $T1
expect_err $DESK_T "A19 Tokyo 07:30-08:30: on Beirut's grid, not on Tokyo's"  "$(sb $TOKYO $T1 "$(tk 3 07:30)" "$(tk 3 08:30)")" not_on_grid
expect_err $DESK_T "A20 Tokyo 22:00-23:00 local = 16:00-17:00 Beirut: refused, Tokyo's hours count" "$(sb $TOKYO $T1 "$(tk 3 22:00)" "$(tk 3 23:00)")" outside_opening_hours
expect_err $DESK_T "A21 Tokyo 06:00-07:00 local"                              "$(sb $TOKYO $T1 "$(tk 3 06:00)" "$(tk 3 07:00)")" outside_opening_hours

echo "  past"
NOW_SLOT="(date_trunc('hour', now() at time zone 'Asia/Beirut') + case when extract(minute from now() at time zone 'Asia/Beirut') >= 30 then interval '30 min' else interval '0' end) at time zone 'Asia/Beirut'"
expect_err $DESK   "A22 wholly in the past (3 days ago, inside hours)"        "$(sb $CLUB $C1 "$(b -3 10:00)" "$(b -3 11:00)")" slot_in_past
expect_err $DESK   "A23 the slot that ended when the current one began"       "$(sb $NIGHT $N1 "$NOW_SLOT - interval '30 min'" "$NOW_SLOT")" slot_in_past
expect     $DESK   "A24 the current slot (started, still running) is allowed" "$(sb $NIGHT $N1 "$NOW_SLOT" "$NOW_SLOT + interval '30 min'")" saved
expect_err $DESK   "A24b a block ending exactly now is wholly past"           "$(sb $NIGHT $N1 "now() - interval '30 min'" "now()")" slot_in_past
clear_court $N1

echo "  overlap (unchanged rules)"
SB_BOOK="select 'booked' from staff_book('$CLUB','$C1', $(b 4 10:00), $(b 4 11:30), 'Walk-in', null);"
expect     $DESK   "A25 desk booking 10:00-11:30"                             "$SB_BOOK" booked
expect_err $DESK   "A26 block over a confirmed booking"                       "$(sb $CLUB $C1 "$(b 4 09:00)" "$(b 4 12:00)")" block_overlaps_booking
expect     $DESK   "A27 block starting when the booking ends"                 "$(sb $CLUB $C1 "$(b 4 11:30)" "$(b 4 13:00)")" saved
expect_err $DESK   "A28 block over another block"                             "$(sb $CLUB $C1 "$(b 4 12:30)" "$(b 4 14:00)")" overlaps_existing_block
expect     $P1     "A29 player holds C2 10:00-11:00 (payment pending)"        "select 'held' from hold_slot('$CLUB','$C2', $(b 4 10:00), $(b 4 11:00));" held
expect_err $DESK   "A30 block over the unexpired hold"                        "$(sb $CLUB $C2 "$(b 4 08:00)" "$(b 4 23:00)")" block_overlaps_booking
$P -c "update bookings set hold_expires_at = now() - interval '1 min' where court_id='$C2' and status='pending'" >/dev/null
expect     $DESK   "A31 the same hold once expired (not yet swept): block saved" "$(sb $CLUB $C2 "$(b 4 08:00)" "$(b 4 23:00)")" saved
expect     owner   "A32 ...and the hold was swept to expired"                 "select status from bookings where court_id='$C2';" expired
clear_court $C1; clear_court $C2

echo "  at the same moment (court lock)"
pair $P1 "select 'held' from hold_slot('$CLUB','$C1', $(b 5 10:00), $(b 5 11:30));" $DESK "$(sb $CLUB $C1 "$(b 5 09:00)" "$(b 5 12:00)")"
grep -q "block_overlaps_booking" /tmp/cbb_b.log && grep -q held /tmp/cbb_a.log && ok "A33 hold saving, block at once: block waits, then refused" || bad "A33" "$(cat /tmp/cbb_a.log /tmp/cbb_b.log | tr '\n' ' ')"
clear_court $C1
pair $DESK "$(sb $CLUB $C1 "$(b 5 09:00)" "$(b 5 12:00)")" $P1 "select 'held' from hold_slot('$CLUB','$C1', $(b 5 10:00), $(b 5 11:30));"
grep -q "slot_blocked\|slot_taken" /tmp/cbb_b.log && grep -q saved /tmp/cbb_a.log && ok "A34 block saving, hold at once: hold waits, then refused" || bad "A34" "$(cat /tmp/cbb_a.log /tmp/cbb_b.log | tr '\n' ' ')"
clear_court $C1
pair $P1 "select 'held' from hold_slot('$CLUB','$C1', $(b 5 10:00), $(b 5 11:30));" $DESK "$(sb $CLUB $C1 "$(b 5 09:00)" "$(b 5 12:00)")" rollback
grep -q saved /tmp/cbb_b.log && ok "A35 hold saving then cancelled: block saved after the wait" || bad "A35" "$(cat /tmp/cbb_b.log | tr '\n' ' ')"
clear_court $C1
pair $DESK "$(sb $CLUB $C1 "$(b 5 09:00)" "$(b 5 12:00)")" $DESK "$(sb $CLUB $C1 "$(b 5 11:00)" "$(b 5 13:00)")"
grep -q overlaps_existing_block /tmp/cbb_b.log && ok "A36 two overlapping blocks at once: second refused" || bad "A36" "$(cat /tmp/cbb_b.log | tr '\n' ' ')"
clear_court $C1
pair $DESK "$(sb $CLUB $C1 "$(b 5 09:00)" "$(b 5 12:00)")" $DESK "select 'booked' from staff_book('$CLUB','$C1', $(b 5 10:00), $(b 5 11:30), 'Walk-in', null);"
grep -q "slot_blocked\|slot_taken" /tmp/cbb_b.log && ok "A37 block saving, desk booking at once: booking refused" || bad "A37" "$(cat /tmp/cbb_b.log | tr '\n' ' ')"
clear_court $C1
pair $DESK "select close_club('$CLUB', $(b 6 08:00), $(b 6 23:00), 'test');" $DESK "$(sb $CLUB $C1 "$(b 6 10:00)" "$(b 6 11:00)")"
grep -q overlaps_existing_block /tmp/cbb_b.log && ok "A38 Close courts saving, block at once: block refused" || bad "A38" "$(cat /tmp/cbb_b.log | tr '\n' ' ')"
$P -c "delete from blocks where reason='test'" >/dev/null

echo "  the old website during the change (direct inserts)"
expect     $DESK   "A39 old page, valid block: saved as before"               "$(di $CLUB $C1 "$(b 7 10:00)" "$(b 7 14:00)")" saved
expect_err $DESK   "A40 old page, off grid: refused with a known message"     "$(di $CLUB $C1 "$(b 7 14:15)" "$(b 7 15:15)")" not_on_grid
expect_err $DESK   "A41 old page, after closing"                              "$(di $CLUB $C1 "$(b 7 22:30)" "$(b 7 23:30)")" outside_opening_hours
expect_err $DESK   "A42 old page, wholly past"                                "$(di $CLUB $C1 "$(b -2 10:00)" "$(b -2 11:00)")" slot_in_past
expect_err $DESK   "A43 old page, inactive court"                             "$(di $CLUB $CX "$(b 7 10:00)" "$(b 7 11:00)")" court_not_found
expect_err $DESK_T "A44 old page, another club's court"                       "$(di $CLUB $C1 "$(b 8 10:00)" "$(b 8 11:00)")" "row-level security"
expect     $DESK   "A45a desk booking on Padel 3"                              "select 'booked' from staff_book('$CLUB','$C3', $(b 9 10:00), $(b 9 11:30), 'Walk-in', null);" booked
expect_err $DESK   "A45 old page, over a booking: same message as before"     "$(di $CLUB $C3 "$(b 9 08:00)" "$(b 9 23:00)")" block_overlaps_booking
expect_err $DESK   "A46 direct change of a block's time to off grid"          "update blocks set end_at = end_at + interval '15 min' where court_id='$C1' and reason='old page' returning 'changed';" bad_duration
expect     $DESK   "A47 delete a block"                                        "with d as (delete from blocks where court_id='$C1' and reason='old page' returning 1) select count(*) from d;" 1
expect     $DESK   "A48 Close courts unchanged: a future day"                 "select close_club('$CLUB', $(b 10 08:00), $(b 10 23:00), 'closed');" 5
expect     $DESK   "A49 Close courts unchanged: still accepts a past day (as before)" "select close_club('$CLUB', $(b -5 08:00), $(b -5 23:00), 'closed');" 5
$P -c "delete from blocks where reason='closed'" >/dev/null
[ "$(blocks_hash)" = "$H0" ] && ok "A50 saved blocks still unchanged" || bad "A50" "changed"

echo "--- stage B: 0077 applied, new website only"
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -1 -f supabase/migrations/0077_blocks_through_functions.sql >/dev/null || { echo "0077 FAILED"; exit 1; }
[ "$(blocks_hash)" = "$H0" ] && ok "B0 saved blocks unchanged by 0077" || bad "B0 saved blocks changed" "$(blocks_hash) vs $H0"
expect     $DESK   "B1 staff_block works"                                     "$(sb $CLUB $C1 "$(b 7 10:00)" "$(b 7 20:00)")" saved
NB=$($P -c "select count(*) from blocks")
expect_err $DESK   "B2 desk staff, direct insert: refused with the 'reload' answer" "$(di $CLUB $C1 "$(b 8 10:00)" "$(b 8 11:00)")" "CourtBook has been updated. Reload the page, then block the time again."
expect_err $ADMIN  "B2b CourtBook admin, direct insert: refused the same way"  "$(di $CLUB $C1 "$(b 8 10:00)" "$(b 8 11:00)")" "CourtBook has been updated."
$P -c "alter table blocks disable trigger blocks_direct_insert_refused" >/dev/null
expect     owner   "B3a (test setup) the reload trigger is now off"          "select tgenabled from pg_trigger where tgname='blocks_direct_insert_refused';" D
expect_err $DESK   "B3 desk staff, direct insert WITHOUT the reload trigger: row-level security refuses" "$(di $CLUB $C1 "$(b 8 10:00)" "$(b 8 11:00)")" "new row violates row-level security policy for table \"blocks\""
expect_err $ADMIN  "B3b admin, direct insert without the trigger: refused too"  "$(di $CLUB $C1 "$(b 8 10:00)" "$(b 8 11:00)")" "row-level security"
$P -c "alter table blocks enable trigger blocks_direct_insert_refused" >/dev/null
expect     owner   "B3c nothing was saved by any of the four attempts"       "select count(*) from blocks;" "$NB"
expect_err $DESK   "B4 direct change of a block: no right to update"          "update blocks set reason='x' where court_id='$C1';" "permission denied for table blocks"
run anon "$(di $CLUB $C1 "$(b 8 12:00)" "$(b 8 13:00)")" >/dev/null
expect     owner   "B5 signed out, direct insert: nothing saved"              "select count(*) from blocks where court_id='$C1' and start_at=$(b 8 12:00);" 0
expect     $DESK_T "B6 staff of another club cannot delete this club's block" "with d as (delete from blocks where court_id='$C1' returning 1) select count(*) from d;" 0
expect     $DESK   "B7 desk reads its club's blocks"                          "select count(*) from blocks where court_id='$C1';" 1
expect     $DESK   "B8 desk deletes a block"                                  "with d as (delete from blocks where court_id='$C1' and reason='test' returning 1) select count(*) from d;" 1
expect     $DESK   "B9 Close courts works"                                    "select close_club('$CLUB', $(b 10 08:00), $(b 10 23:00), 'closed');" 5
expect_err $DESK   "B10 Close courts over a block: same message as before"    "select close_club('$CLUB', $(b 10 08:00), $(b 10 23:00), 'closed');" overlaps_existing_block
expect     $DESK   "B11 staff deletes Close-courts blocks"                    "with d as (delete from blocks where reason='closed' returning 1) select count(*) from d;" 5
expect_err $DESK   "B12 rules still apply through staff_block"                "$(sb $CLUB $C1 "$(b 8 14:15)" "$(b 8 15:15)")" not_on_grid
expect     owner   "B13 policies on blocks"                                   "select string_agg(polname||'/'||polcmd::text, ', ' order by polname) from pg_policy where polrelid='blocks'::regclass;" "blocks: staff delete/d, blocks: staff read/r"
expect     owner   "B14 signed-in rights on blocks: no update; insert (reload answer only), delete, read" "select has_table_privilege('authenticated','blocks','UPDATE')||' '||has_table_privilege('authenticated','blocks','INSERT')||' '||has_table_privilege('authenticated','blocks','DELETE')||' '||has_table_privilege('authenticated','blocks','SELECT');" "false true true true"
expect     owner   "B15 staff_block: owner rights, fixed search_path, signed-in only" "select prosecdef||' '||array_to_string(proconfig,',')||' '||has_function_privilege('authenticated',oid,'EXECUTE')||' '||has_function_privilege('anon',oid,'EXECUTE') from pg_proc where proname='staff_block';" "true search_path=public true false"
[ "$(blocks_hash)" = "$H0" ] && ok "B16 saved blocks still unchanged" || bad "B16" "changed"

echo "--- re-applying 0076 and 0077 (the suite re-runs every migration)"
for f in 0076_staff_block 0077_blocks_through_functions; do
  e=$($PSQL -d $DB -v ON_ERROR_STOP=1 -1 -f supabase/migrations/$f.sql 2>&1 >/dev/null | grep -m1 ERROR)
  [ -z "$e" ] && ok "R1 $f re-applies" || bad "R1 $f" "$e"
done
expect_err $DESK   "R2 after re-applying: direct insert still refused with 'reload'" "$(di $CLUB $C1 "$(b 8 10:00)" "$(b 8 11:00)")" "Reload the page"
expect     owner   "R3 triggers on blocks"                                    "select string_agg(tgname, ', ' order by tgname) from pg_trigger where tgrelid='blocks'::regclass and not tgisinternal;" "blocks_booking_check, blocks_direct_insert_refused"

echo "--- rollbacks (0077 first, then 0076)"
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -f supabase/live/0077_rollback.sql >/dev/null 2>&1 && ok "K1 0077 rollback runs" || bad "K1" "failed"
expect     $DESK   "K2 after 0077 rollback: old page inserts again, with 0076's rules" "$(di $CLUB $C1 "$(b 8 10:00)" "$(b 8 11:00)")" saved
expect_err $DESK   "K3 ...still refusing off grid"                            "$(di $CLUB $C1 "$(b 8 14:15)" "$(b 8 15:15)")" not_on_grid
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -f supabase/live/0076_rollback.sql >/dev/null 2>&1 && ok "K4 0076 rollback runs" || bad "K4" "failed"
expect     $DESK   "K5 after both rollbacks: back to 0075 (off grid accepted again)" "$(di $CLUB $C1 "$(b 8 14:15)" "$(b 8 15:15)")" saved
expect     owner   "K6 staff_block gone"                                      "select count(*) from pg_proc where proname in ('staff_block','assert_valid_block','blocks_direct_write_rules','blocks_direct_insert_refused');" 0
expect     owner   "K7 policies back to 0075"                                 "select string_agg(polname||'/'||polcmd::text, ', ' order by polname) from pg_policy where polrelid='blocks'::regclass;" "blocks: staff read/r, blocks: staff write/*"
[ "$(blocks_hash)" = "$H0" ] && ok "K8 saved blocks unchanged through both rollbacks" || bad "K8" "changed"

echo
echo "checks: $CHECKS, failures: $FAILS"
[ "$FAILS" -eq 0 ] || { echo "BLOCKS SUITE FAILED"; exit 1; }
echo "BLOCKS SUITE OK"
