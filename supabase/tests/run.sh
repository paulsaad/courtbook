#!/usr/bin/env bash
# Local test of the schema: applies all migrations + seed to a scratch Postgres database
# (with a minimal shim of Supabase's auth schema and grants) and checks the booking rules.
# Usage: PSQL="psql -U postgres" supabase/tests/run.sh
set -u
cd "$(dirname "$0")/../.."
PSQL=${PSQL:-psql}
DB=courtbook_test
P1=11111111-1111-1111-1111-111111111111
P2=22222222-2222-2222-2222-222222222222
ADMIN=33333333-3333-3333-3333-333333333333
STAFF_B=44444444-4444-4444-4444-444444444444

$PSQL -q -c "drop database if exists $DB" -c "create database $DB" >/dev/null
# each migration file in its own transaction (0011 adds enum values that 0012 uses)
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql || exit 1
for f in $(ls supabase/migrations/*.sql | sort); do
  $PSQL -q -d $DB -v ON_ERROR_STOP=1 -1 -f "$f" || { echo "MIGRATION FAILED: $f"; exit 1; }
done
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -f supabase/seed.sql || exit 1
echo "migrations + seed: OK"
# SELFTEST=1: deliberately break a privacy rule to prove the suite fails (expect exit 1 with 82f/I9 failing)
if [ -n "${SELFTEST:-}" ]; then $PSQL -q -d $DB -c "grant select (created_by) on towns to anon; grant select on notifications to anon;"; echo "SELFTEST: privacy deliberately broken"; fi

$PSQL -q -d $DB -v ON_ERROR_STOP=1 <<EOF
insert into auth.users (id, phone) values ('$P1','+9611'), ('$P2','+9612'), ('$ADMIN','+9613'), ('$STAFF_B','+9614');
update profiles set roles='{player,admin}' where id='$ADMIN';
update clubs set cancel_cutoff_hours = 6 where slug = 'batroun';
insert into clubs (name, slug) values ('Other Club', 'other');
insert into courts (club_id, name, sport) select id, 'Other 1', 'padel' from clubs where slug='other';
insert into club_staff (club_id, profile_id) select id, '$STAFF_B' from clubs where slug='other';
EOF
COURT=$($PSQL -At -d $DB -c "select id from courts where name='Padel 1'")
COURT2=$($PSQL -At -d $DB -c "select id from courts where name='Padel 2'")
COURT3=$($PSQL -At -d $DB -c "select id from courts where name='Padel 3'")
CLUB=$($PSQL -At -d $DB -c "select id from clubs where slug='batroun'")
CLUB_B=$($PSQL -At -d $DB -c "select id from clubs where slug='other'")
# Tomorrow 09:30-11:00 Beirut (club opens 08:00, 30-min grid, players 60-180 min)
S="(current_date + 1 + time '09:30') at time zone 'Asia/Beirut'"
E="(current_date + 1 + time '11:00') at time zone 'Asia/Beirut'"
as_user() { echo "set role authenticated; select set_config('request.jwt.claim.sub','$1',false);"; }
as_service() { echo "set role service_role; select set_config('request.jwt.claim.sub','',false);"; }
filter() { grep -vE "^(SET|UPDATE|INSERT|DELETE|set_config|-+|\(1 row\)|\(0 rows\)|\s*$|CONTEXT|LINE|\s+\^| 1111| 2222| 3333| 4444| set_config|PL/pgSQL|SQL statement|\s+values|\s+insert)"; }
pay_of() { $PSQL -At -d $DB -c "select id from payments where booking_id='$1'"; }

# ---- assertions: the script exits 1 if any check fails (the printed sections above are for reading; these decide)
FAILS=0; CHECKS=0
who_sql() { case $1 in anon) echo "set role anon; select set_config('request.jwt.claim.sub','',false);";; service) as_service;; *) as_user $1;; esac; }
# check <who> <label> <sql returning one value> <expected>
check() { CHECKS=$((CHECKS+1)); local got; got=$({ who_sql $1; echo "$3"; } | $PSQL -At -d $DB 2>&1 | grep -v set_config | tail -1)
  if [ "$got" == "$4" ]; then echo "  ok    $2"; else echo "  FAIL  $2 — expected [$4] got [$got]"; FAILS=$((FAILS+1)); fi; }
# denied <who> <label> <sql> : must raise (permission denied or a business error)
denied() { CHECKS=$((CHECKS+1)); local out got; out=$({ who_sql $1; echo "$3"; } | $PSQL -At -d $DB 2>&1 | grep -v set_config); got=$(echo "$out" | grep -m1 ERROR)
  if [ -n "$got" ]; then echo "  ok    $2 ($got)"; else echo "  FAIL  $2 — expected an error, got [$(echo "$out" | tail -1)]"; FAILS=$((FAILS+1)); fi; }
# claim <label> <0 for pass, anything else for fail> : for checks decided by reading a session's log
claim() { CHECKS=$((CHECKS+1)); if [ "$2" = 0 ]; then echo "  ok    $1"; else echo "  FAIL  $1"; FAILS=$((FAILS+1)); fi; }

echo "--- A. two players hold the same slot concurrently -> one hold, other slot_taken"
hold() { { as_user $1; echo "begin; select booking_id from hold_slot('$CLUB','$2', $S, $E); select pg_sleep(1.5); commit;"; } | $PSQL -d $DB 2>&1; }
hold $P1 $COURT > /tmp/cb_p1.log & sleep 0.4; hold $P2 $COURT > /tmp/cb_p2.log & wait
grep -q "ERROR:  slot_taken" /tmp/cb_p2.log && echo "loser got slot_taken: OK" || { echo "FAIL"; cat /tmp/cb_p2.log; }
B=$($PSQL -At -d $DB -c "select id from bookings where status='pending' and player_id='$P1'")
PAY=$(pay_of $B)
$PSQL -At -d $DB -c "select 'price,fee,total = '||amount_usd||','||fee_usd||','||total_usd||' (expect 30.00,1.00,31.00: 1.5h off-peak at 20/h)' from payments where id='$PAY'"

echo "--- B. payment confirmation"
{ as_user $P1; cat <<EOF
\set ON_ERROR_STOP off
\echo '1. player tries confirm_payment directly -> expect permission denied'
select confirm_payment('$PAY', 'SIM-1', 31.00);
\echo '2. player tries to update bookings/payments directly -> expect UPDATE 0 (no policy) and permission/RLS'
update bookings set status='confirmed' where id='$B';
update payments set status='paid' where id='$PAY';
select status from payments where id='$PAY';
EOF
as_service; cat <<EOF
\echo '3. service confirms with wrong amount -> expect ERROR amount_mismatch'
select confirm_payment('$PAY', 'SIM-1', 30.00);
\echo '4. service confirms -> expect confirmed ; again -> expect already_paid (idempotent)'
select confirm_payment('$PAY', 'SIM-1', 31.00);
select confirm_payment('$PAY', 'SIM-1', 31.00);
select status from bookings where id='$B'; select status from payments where id='$PAY';
EOF
} | $PSQL -d $DB 2>&1 | filter

echo "--- C. expired hold never confirms a slot someone else took"
$PSQL -q -d $DB -c "update clubs set hold_minutes=2 where id='$CLUB'"
S2="(current_date + 2 + time '09:30') at time zone 'Asia/Beirut'"; E2="(current_date + 2 + time '11:00') at time zone 'Asia/Beirut'"
B2=$({ as_user $P1; echo "select booking_id from hold_slot('$CLUB','$COURT', $S2, $E2);"; } | $PSQL -At -d $DB | tail -1)
PAY2=$(pay_of $B2)
$PSQL -q -d $DB -c "update bookings set hold_expires_at = now() - interval '1 min' where id='$B2'"   # simulate time passing
{ as_user $P2; cat <<EOF
\set ON_ERROR_STOP off
\echo '5. player2 holds the same slot after player1 hold expired -> expect a booking id (stale hold swept)'
select booking_id is not null as got_hold from hold_slot('$CLUB','$COURT', $S2, $E2);
EOF
as_service; cat <<EOF
\echo '6. late payment for player1 expired hold -> expect refund_due, booking stays expired'
select confirm_payment('$PAY2', 'SIM-2', 31.00);
select status from bookings where id='$B2'; select status from payments where id='$PAY2';
\echo '7. duplicate provider ref on another payment -> expect ERROR duplicate_provider_ref'
select confirm_payment((select id from payments where profile_id='$P2' and status='pending' limit 1), 'SIM-1', 31.00);
EOF
} | $PSQL -d $DB 2>&1 | filter
$PSQL -q -d $DB -c "update clubs set hold_minutes=10 where id='$CLUB'"

echo "--- D. hold rules"
{ as_user $P2; cat <<EOF
\set ON_ERROR_STOP off
\echo '8. second hold for the same player replaces the first -> expect 1 live hold, on Padel 2'
select booking_id is not null from hold_slot('$CLUB','$COURT2', $S, $E);
select count(*) as live_holds, bool_and(court_id='$COURT2') as on_padel2 from bookings where player_id=auth.uid() and status='pending';
\echo '9. release hold -> then holding another slot works ; my_active_hold shows it'
select release_hold((select id from bookings where player_id=auth.uid() and status='pending'));
select booking_id is not null from hold_slot('$CLUB','$COURT2', $S, $E);
select court_name from my_active_hold();
\echo '10. bad durations: 45 min -> bad_duration ; 30 min (<60 min minimum) -> bad_duration'
select release_hold((select id from bookings where player_id=auth.uid() and status='pending'));
select booking_id from hold_slot('$CLUB','$COURT3', $S, $S + interval '45 min');
select booking_id from hold_slot('$CLUB','$COURT3', $S, $S + interval '30 min');
\echo '11. off-grid 09:45 -> not_on_grid ; before opening -> outside_opening_hours ; other club court -> court_not_found ; 20 days ahead -> beyond_booking_window'
select booking_id from hold_slot('$CLUB','$COURT3', $S + interval '15 min', $E + interval '15 min');
select booking_id from hold_slot('$CLUB','$COURT3', (current_date + 1 + time '06:30') at time zone 'Asia/Beirut', (current_date + 1 + time '08:00') at time zone 'Asia/Beirut');
select booking_id from hold_slot('$CLUB_B','$COURT3', $S, $E);
select booking_id from hold_slot('$CLUB','$COURT3', (current_date + 20 + time '09:30') at time zone 'Asia/Beirut', (current_date + 20 + time '11:00') at time zone 'Asia/Beirut');
\echo '12. peak price: 2h at 17:00 (30/h) -> expect 60.00'
select quote_price('$COURT3', (current_date + 1 + time '17:00') at time zone 'Asia/Beirut', (current_date + 1 + time '19:00') at time zone 'Asia/Beirut');
\echo '13. occupancy shows player1 confirmed booking as Booked with null id; own ids visible'
select count(*) filter (where id is null) as others, count(*) filter (where mine) as mine from occupancy;
EOF
} | $PSQL -d $DB 2>&1 | filter

echo "--- E. staff rules (blocks, moves, cross-club, direct updates)"
{ as_user $ADMIN; cat <<EOF
\set ON_ERROR_STOP off
\echo '14. block over player1 confirmed booking -> expect ERROR block_overlaps_booking'
insert into blocks (club_id, court_id, start_at, end_at, reason, created_by) values ('$CLUB','$COURT', $S, $S + interval '60 min','maint','$ADMIN');
\echo '15. block a free window (day+3 08:00-12:30) -> ok ; then player holds inside it -> expect slot_taken'
insert into blocks (club_id, court_id, start_at, end_at, reason, created_by) values ('$CLUB','$COURT', (current_date + 3 + time '08:00') at time zone 'Asia/Beirut', (current_date + 3 + time '12:30') at time zone 'Asia/Beirut','tournament','$ADMIN');
EOF
as_user $P1; cat <<EOF
select booking_id from hold_slot('$CLUB','$COURT', (current_date + 3 + time '09:30') at time zone 'Asia/Beirut', (current_date + 3 + time '11:00') at time zone 'Asia/Beirut');
\echo '16. self-promote -> roles {player} ; read others balance -> forbidden'
update profiles set roles='{player,admin}' where id=auth.uid(); select roles from profiles where id=auth.uid();
EOF
as_user $STAFF_B; cat <<EOF
\echo '17. staff of club B: insert booking on club A court -> court_not_found ; update club A booking -> UPDATE 0 ; move it -> forbidden'
insert into bookings (club_id, court_id, guest_name, start_at, end_at, source, created_by) values ('$CLUB_B','$COURT2','Walk-in', $S, $E, 'staff', auth.uid());
update bookings set status='cancelled' where id='$B';
select move_booking('$B','$COURT3', $S, $E);
EOF
as_user $ADMIN; cat <<EOF
\echo '18. admin moves player1 booking to Padel 3 -> ok ; to 02:00 -> outside_opening_hours ; 4h05 -> bad_duration ; 09:45 -> not_on_grid'
select move_booking('$B','$COURT3', $S, $E);
select move_booking('$B','$COURT3', (current_date + 1 + time '02:00') at time zone 'Asia/Beirut', (current_date + 1 + time '03:30') at time zone 'Asia/Beirut');
select move_booking('$B','$COURT3', $S, $S + interval '4 hour 5 min');
select move_booking('$B','$COURT3', $S + interval '15 min', $E + interval '15 min');
\echo '19. staff walk-in 21:30-23:00 -> ok ; 21:00-00:00 -> outside_opening_hours ; 09:30:30 start -> not_on_grid'
insert into bookings (club_id, court_id, guest_name, guest_phone, start_at, end_at, source, created_by) values ('$CLUB','$COURT','Walk-in','+961', (current_date + 1 + time '21:30') at time zone 'Asia/Beirut', (current_date + 1 + time '23:00') at time zone 'Asia/Beirut', 'staff', auth.uid());
insert into bookings (club_id, court_id, guest_name, start_at, end_at, source, created_by) values ('$CLUB','$COURT2','X', (current_date + 1 + time '21:00') at time zone 'Asia/Beirut', (current_date + 2 + time '00:00') at time zone 'Asia/Beirut', 'staff', auth.uid());
insert into bookings (club_id, court_id, guest_name, start_at, end_at, source, created_by) values ('$CLUB','$COURT2','X', $S + interval '30 sec', $E + interval '30 sec', 'staff', auth.uid());
\echo '19b. stale hold (expired, unswept) on Padel 2 day+2 does not block a staff booking -> ok'
insert into bookings (club_id, court_id, player_id, start_at, end_at, status, source, created_by, hold_expires_at, price_usd, fee_usd) values ('$CLUB','$COURT2','$P2', (current_date + 2 + time '12:30') at time zone 'Asia/Beirut', (current_date + 2 + time '14:00') at time zone 'Asia/Beirut', 'pending','app','$P2', now() - interval '1 min', 30, 1);
insert into bookings (club_id, court_id, guest_name, start_at, end_at, source, created_by) values ('$CLUB','$COURT2','Walk-in', (current_date + 2 + time '12:30') at time zone 'Asia/Beirut', (current_date + 2 + time '14:00') at time zone 'Asia/Beirut', 'staff', auth.uid());
select count(*) as staff_bookings_there from bookings where court_id='$COURT2' and status='confirmed' and guest_name='Walk-in' and start_at=(current_date + 2 + time '12:30') at time zone 'Asia/Beirut';
\echo '20. close day+1 with bookings -> block_overlaps_booking ; close day+5 -> 5'
select close_club('$CLUB', (current_date + 1 + time '08:00') at time zone 'Asia/Beirut', (current_date + 1 + time '23:00') at time zone 'Asia/Beirut', 'holiday');
select close_club('$CLUB', (current_date + 5 + time '08:00') at time zone 'Asia/Beirut', (current_date + 5 + time '23:00') at time zone 'Asia/Beirut', 'holiday');
EOF
} | $PSQL -d $DB 2>&1 | filter

echo "--- F. cancellation and refunds (cutoff 6h)"
{ as_user $P2; cat <<EOF
\set ON_ERROR_STOP off
\echo '21. player2 cancels player1 booking -> forbidden ; passes club_caused -> forbidden'
select cancel_booking('$B'); select cancel_booking('$B', true);
EOF
as_user $P1; cat <<EOF
\echo '22. player1 cancels own paid booking >6h ahead -> payment refund_due'
select cancel_booking('$B'); select status from payments where booking_id='$B';
EOF
} | $PSQL -d $DB 2>&1 | filter
# late cancellation: paid booking starting in 2h (inserted directly, grid-aligned by using hold on a near slot is awkward; insert confirmed + paid rows)
$PSQL -q -d $DB -v ON_ERROR_STOP=1 <<EOF
update clubs set cancel_cutoff_hours = 48 where id='$CLUB';
insert into bookings (id, club_id, court_id, player_id, start_at, end_at, status, source, created_by, price_usd, fee_usd)
values ('55555555-5555-5555-5555-555555555555','$CLUB','$COURT3','$ADMIN', (current_date + 1 + time '12:30') at time zone 'Asia/Beirut', (current_date + 1 + time '14:00') at time zone 'Asia/Beirut', 'confirmed','app','$ADMIN', 30, 1);
insert into payments (booking_id, profile_id, club_id, provider, provider_ref, amount_usd, fee_usd, total_usd, status, paid_at)
values ('55555555-5555-5555-5555-555555555555','$ADMIN','$CLUB','simulated','SIM-L1',30,1,31,'paid',now());
insert into bookings (id, club_id, court_id, player_id, start_at, end_at, status, source, created_by, price_usd, fee_usd)
values ('66666666-6666-6666-6666-666666666666','$CLUB','$COURT3','$ADMIN', (current_date + 1 + time '14:00') at time zone 'Asia/Beirut', (current_date + 1 + time '15:30') at time zone 'Asia/Beirut', 'confirmed','app','$ADMIN', 30, 1);
insert into payments (booking_id, profile_id, club_id, provider, provider_ref, amount_usd, fee_usd, total_usd, status, paid_at)
values ('66666666-6666-6666-6666-666666666666','$ADMIN','$CLUB','simulated','SIM-L2',30,1,31,'paid',now());
insert into club_staff (club_id, profile_id) values ('$CLUB','$STAFF_B');
EOF
{ as_user $ADMIN; cat <<EOF
\set ON_ERROR_STOP off
\echo '23. staff cancels OWN booking inside cutoff -> payment stays paid (no refund) ; flags own as club-caused -> forbidden'
select cancel_booking('55555555-5555-5555-5555-555555555555'); select status from payments where booking_id='55555555-5555-5555-5555-555555555555';
select cancel_booking('66666666-6666-6666-6666-666666666666', true);
EOF
as_user $STAFF_B; cat <<EOF
\echo '24. another staff cancels it club-caused -> refund_due'
select cancel_booking('66666666-6666-6666-6666-666666666666', true); select status from payments where booking_id='66666666-6666-6666-6666-666666666666';
\echo '25. staff reads payments of own club -> 2+ rows ; anon reads occupancy -> permission denied'
select count(*) >= 2 from payments where club_id='$CLUB';
set role anon; select count(*) from occupancy;
EOF
} | $PSQL -d $DB 2>&1 | filter

echo "--- G. DST: real elapsed time (London test club)"
$PSQL -q -d $DB -c "update clubs set timezone='Europe/London', open_time='00:00', close_time='24:00', slot_minutes=90, min_booking_minutes=90, max_booking_minutes=180 where id='$CLUB'"
{ as_user $ADMIN; cat <<EOF
\set ON_ERROR_STOP off
\echo '26. 90 real min across spring-forward -> ok ; 150 real min that look like 90 local across fall-back -> bad_duration'
insert into bookings (club_id, court_id, guest_name, start_at, end_at, source, created_by) values ('$CLUB','$COURT','DST', '2027-03-28 00:00:00+00', '2027-03-28 01:30:00+00', 'staff', auth.uid());
insert into bookings (club_id, court_id, guest_name, start_at, end_at, source, created_by) values ('$CLUB','$COURT','DST', '2027-10-31 00:00:00+00', '2027-10-31 02:30:00+00', 'staff', auth.uid());
EOF
} | $PSQL -d $DB 2>&1 | filter
$PSQL -q -d $DB -c "update clubs set timezone='Asia/Beirut', open_time='08:00', close_time='23:00', slot_minutes=30, min_booking_minutes=60, max_booking_minutes=180, cancel_cutoff_hours=6 where id='$CLUB'"

echo "--- H. names"
$PSQL -q -d $DB -c "insert into matches (id, club_id, sport, organizer_id, start_at, players_needed) values ('77777777-7777-7777-7777-777777777777','$CLUB','padel','$P1', now()+interval '3 day', 3)"
{ as_user $P2; cat <<EOF
\set ON_ERROR_STOP off
\echo '27. player2 looks up player1 -> 0 ; after joining their match -> 1'
select count(*) from player_names(array['$P1'::uuid]);
insert into match_players (match_id, profile_id) values ('77777777-7777-7777-7777-777777777777', auth.uid());
select count(*) from player_names(array['$P1'::uuid]);
EOF
as_user $ADMIN; cat <<EOF
\echo '28. staff looks up a booker at their club -> 1 ; anon -> permission denied'
select count(*) from player_names(array['$P1'::uuid]);
set role anon; select count(*) from player_names(array['$P1'::uuid]);
EOF
} | $PSQL -d $DB 2>&1 | filter

echo "--- I. lock order: concurrent confirm vs cancel / release / replacement -> no deadlocks (review Phase 2 #2)"
$PSQL -q -d $DB -c "update clubs set hold_minutes=10 where id='$CLUB'"
S9="(current_date + 6 + time '09:30') at time zone 'Asia/Beirut'"; E9="(current_date + 6 + time '11:00') at time zone 'Asia/Beirut'"
S9b="(current_date + 6 + time '12:30') at time zone 'Asia/Beirut'"; E9b="(current_date + 6 + time '14:00') at time zone 'Asia/Beirut'"
for round in 1 2 3; do
  BH=$({ as_user $P1; echo "select booking_id from hold_slot('$CLUB','$COURT', $S9, $E9);"; } | $PSQL -At -d $DB | tail -1)
  PH=$(pay_of $BH)
  case $round in
    1) # confirm vs cancel (player)
       { as_service; echo "begin; select confirm_payment('$PH','SIM-D$round',31.00); select pg_sleep(0.5); commit;"; } | $PSQL -d $DB > /tmp/cb_d1.log 2>&1 &
       { as_user $P1; echo "begin; select cancel_booking('$BH'); select pg_sleep(0.5); commit;"; } | $PSQL -d $DB > /tmp/cb_d2.log 2>&1 & ;;
    2) # confirm vs release
       { as_service; echo "begin; select confirm_payment('$PH','SIM-D$round',31.00); select pg_sleep(0.5); commit;"; } | $PSQL -d $DB > /tmp/cb_d1.log 2>&1 &
       { as_user $P1; echo "begin; select release_hold('$BH'); select pg_sleep(0.5); commit;"; } | $PSQL -d $DB > /tmp/cb_d2.log 2>&1 & ;;
    3) # confirm vs the same player replacing the hold with another court
       { as_service; echo "begin; select confirm_payment('$PH','SIM-D$round',31.00); select pg_sleep(0.5); commit;"; } | $PSQL -d $DB > /tmp/cb_d1.log 2>&1 &
       { as_user $P1; echo "begin; select booking_id from hold_slot('$CLUB','$COURT2', $S9b, $E9b); select pg_sleep(0.5); commit;"; } | $PSQL -d $DB > /tmp/cb_d2.log 2>&1 & ;;
  esac
  wait
  if grep -q "deadlock" /tmp/cb_d1.log /tmp/cb_d2.log; then echo "round $round: FAIL deadlock"; cat /tmp/cb_d1.log /tmp/cb_d2.log; else
    echo "round $round: no deadlock; booking=$($PSQL -At -d $DB -c "select status from bookings where id='$BH'") payment=$($PSQL -At -d $DB -c "select status from payments where id='$PH'")"; fi
  $PSQL -q -d $DB -c "update bookings set status='cancelled' where id in (select id from bookings where player_id='$P1' and status in ('confirmed','pending') and start_at >= $S9)" 
done
echo "--- J. idempotency identity (review Phase 2 #3)"
BI=$({ as_user $P1; echo "select booking_id from hold_slot('$CLUB','$COURT3', $S9, $E9);"; } | $PSQL -At -d $DB | tail -1); PI=$(pay_of $BI)
{ as_service; cat <<EOF
\set ON_ERROR_STOP off
\echo '29. confirm -> confirmed ; identical retry -> already_paid ; different ref -> ERROR payment_mismatch ; different amount -> ERROR payment_mismatch'
select confirm_payment('$PI','SIM-I1',31.00);
select confirm_payment('$PI','SIM-I1',31.00);
select confirm_payment('$PI','SIM-I2',31.00);
select confirm_payment('$PI','SIM-I1',30.00);
EOF
} | $PSQL -d $DB 2>&1 | filter

echo "--- K. same player, two tabs, two courts at once -> exactly one live hold (review Phase 2 round 2)"
$PSQL -q -d $DB -c "update bookings set status='cancelled' where player_id='$P2' and status='pending'"
S10="(current_date + 7 + time '09:30') at time zone 'Asia/Beirut'"; E10="(current_date + 7 + time '11:00') at time zone 'Asia/Beirut'"
tab() { { as_user $P2; echo "begin; select booking_id from hold_slot('$CLUB','$1', $S10, $E10); select pg_sleep(1); commit;"; } | $PSQL -d $DB > $2 2>&1; }
tab $COURT /tmp/cb_t1.log & sleep 0.3; tab $COURT2 /tmp/cb_t2.log & wait
grep -q "deadlock\|hold_conflict" /tmp/cb_t1.log /tmp/cb_t2.log && { echo "FAIL"; cat /tmp/cb_t1.log /tmp/cb_t2.log; }
$PSQL -At -d $DB -c "select 'live holds = '||count(*)||' (expect 1) ; pending payments = '||(select count(*) from payments where profile_id='$P2' and status='pending')||' (expect 1)' from bookings where player_id='$P2' and status='pending'"
$PSQL -At -d $DB -c "select 'unique index present: '||(exists(select 1 from pg_indexes where indexname='one_pending_hold_per_player'))::text"

echo "--- L. club admin RPCs"
{ as_user $P2; cat <<EOF
\set ON_ERROR_STOP off
\echo '30. player updates club settings -> forbidden ; adds staff -> forbidden'
select update_club_settings('$CLUB','08:00','23:00',30,60,180,6,10,14,'');
select add_club_staff('$CLUB','+9612');
EOF
as_user $ADMIN; cat <<EOF
\echo '31. admin adds staff by email (none in test) -> user_not_found ; staff list works -> rows'
select add_club_staff('$CLUB','nobody@example.com');
select count(*) >= 1 from club_staff_list('$CLUB');
EOF
as_user $STAFF_B; cat <<EOF
\echo '32. staff updates own club hours -> ok ; inserts price rules for both clubs they staff -> ok'
select update_club_settings('$CLUB','07:00','23:00',30,60,180,6,10,14,'https://maps.example');
insert into price_rules (club_id, court_id, weekday_mask, start_time, end_time, price_usd, label) values ('$CLUB', null, 127, '07:00','08:00', 15, 'early');
insert into price_rules (club_id, court_id, weekday_mask, start_time, end_time, price_usd, label) values ((select id from clubs where slug='other'), null, 127, '07:00','08:00', 15, 'early');
EOF
} | $PSQL -d $DB 2>&1 | filter
$PSQL -q -d $DB -c "delete from club_staff where club_id='$CLUB' and profile_id='$STAFF_B'" 2>/dev/null

echo "--- M. payments dashboard RPCs"
{ as_user $P2; cat <<EOF
\set ON_ERROR_STOP off
\echo '33. player: payments_summary -> 0 rows ; refunds_due -> 0 rows ; mark_refunded on an invisible payment -> not_found'
select count(*) from payments_summary(current_date);
select count(*) from refunds_due();
select mark_refunded((select id from payments where status='refund_due' limit 1));
EOF
as_user $ADMIN; cat <<EOF
\echo '34. admin: summary has Batroun with paid count>0 ; refunds_due > 0 ; mark one refunded -> refunded'
select club_name, bookings > 0 as has_paid, fees > 0 as has_fees, refunds_due from payments_summary(current_date) where club_name like 'Batroun%';
select count(*) > 0 from refunds_due();
select mark_refunded((select payment_id from refunds_due() limit 1));
select count(*) from payments where status='refunded';
\echo '35. payments_list for Batroun this month -> rows with court names'
select count(*) > 0, bool_and(court_name is not null) from payments_list('$CLUB', current_date);
EOF
} | $PSQL -d $DB 2>&1 | filter

echo "--- N. Phase 3 review: price rule overlap, payouts, refunds club_id"
{ as_user $ADMIN; cat <<EOF
\set ON_ERROR_STOP off
\echo '36. overlapping club-wide rule (Sat 10:00-12:00 vs existing every-day 08:00-17:00) -> ERROR price_rule_overlap ; court-specific rule for same window -> ok'
insert into price_rules (club_id, court_id, weekday_mask, start_time, end_time, price_usd) values ('$CLUB', null, 32, '10:00', '12:00', 25);
insert into price_rules (club_id, court_id, weekday_mask, start_time, end_time, price_usd) values ('$CLUB', '$COURT', 32, '10:00', '12:00', 25);
\echo '37. club_balances: club_share > 0, outstanding = share ; record payout 10 -> outstanding = share - 10'
select club_share > 0, outstanding = club_share from club_balances() where club_id='$CLUB';
insert into club_payouts (club_id, amount_usd, method, created_by) values ('$CLUB', 10, 'cash', auth.uid());
select outstanding = club_share - 10 from club_balances() where club_id='$CLUB';
\echo '38. refunds_due has club_id column'
select count(*) >= 0 from refunds_due() where club_id is not null;
EOF
as_user $STAFF_B; cat <<EOF
\echo '39. staff records payout -> RLS error'
insert into club_payouts (club_id, amount_usd, created_by) values ('$CLUB', 5, auth.uid());
EOF
} | $PSQL -d $DB 2>&1 | filter

echo "--- O. concurrency: overlapping price rules (both see none) -> exactly one succeeds ; session claim -> one true"
rule() { { as_user $ADMIN; echo "begin; insert into price_rules (club_id, court_id, weekday_mask, start_time, end_time, price_usd, label) values ('$CLUB','$COURT2', 8, '20:00','21:00', 99, 'race-$1'); select pg_sleep(1); commit;"; } | $PSQL -d $DB > /tmp/cb_r$1.log 2>&1; }
rule 1 & sleep 0.3; rule 2 & wait
$PSQL -At -d $DB -c "select 'race rules committed = '||count(*)||' (expect 1)' from price_rules where label like 'race-%'"
BQ=$({ as_user $P1; echo "select booking_id from hold_slot('$CLUB','$COURT3', (current_date + 8 + time '09:30') at time zone 'Asia/Beirut', (current_date + 8 + time '11:00') at time zone 'Asia/Beirut');"; } | $PSQL -At -d $DB | tail -1); PQ=$(pay_of $BQ)
{ as_service; echo "select claim_payment_session('$PQ'); select claim_payment_session('$PQ'); select release_payment_session_claim('$PQ'); select claim_payment_session('$PQ');"; } | $PSQL -At -d $DB 2>&1 | grep -E "^(t|f)$" | tr '\n' ' '; echo "(expect t f t)"

echo "--- P. coaches: profile, club request, approval, availability"
{ as_user $P1; cat <<EOF
\set ON_ERROR_STOP off
\echo '40. player1 becomes a coach, requests Batroun -> ok ; player2 cannot see them yet (not approved) -> 0'
insert into coaches (profile_id, sports, levels, price_usd, bio, whatsapp) values (auth.uid(), '{padel}', '{beginner,intermediate}', 25, 'Padel coach', '+96170000000');
insert into coach_clubs (coach_id, club_id) values (my_coach_id(), '$CLUB');
insert into availability_rules (coach_id, club_id, weekday, start_time, end_time) values (my_coach_id(), '$CLUB', 1, '09:00', '12:00');
insert into availability_rules (coach_id, club_id, weekday, start_time, end_time) values (my_coach_id(), '$CLUB', 1, '15:00', '18:00');
EOF
as_user $P2; cat <<EOF
select count(*) from coaches_at_club('$CLUB');
\echo '41. player2 tries to approve -> RLS: UPDATE 0'
update coach_clubs set status='approved' where club_id='$CLUB';
EOF
as_user $ADMIN; cat <<EOF
\echo '42. staff sees the pending request -> 1 ; approves -> ok'
select count(*) from club_coach_requests('$CLUB') where status='pending';
select decide_coach_club((select coach_id from club_coach_requests('$CLUB') limit 1), '$CLUB', true);
EOF
as_user $P2; cat <<EOF
\echo '43. player2 now sees 1 coach ; availability next Tuesday has 2 windows ; after a closed-day exception -> 0'
select count(*) from coaches_at_club('$CLUB');
select count(*) from coach_availability((select coach_id from coaches_at_club('$CLUB') limit 1), '$CLUB', (current_date + ((8 - extract(isodow from current_date)::int) % 7 + 1))::date, 1);
EOF
as_user $P1; cat <<EOF
insert into availability_exceptions (coach_id, date, available) values (my_coach_id(), (current_date + ((8 - extract(isodow from current_date)::int) % 7 + 1))::date, false);
EOF
as_user $P2; cat <<EOF
select count(*) from coach_availability((select coach_id from coaches_at_club('$CLUB') limit 1), '$CLUB', (current_date + ((8 - extract(isodow from current_date)::int) % 7 + 1))::date, 1);
\echo '44. player2 edits coach availability -> RLS (0 rows) ; coach_card visible -> 1 row'
delete from availability_rules where club_id='$CLUB';
select count(*) from availability_rules where club_id='$CLUB';
select count(*) from coach_card((select coach_id from coaches_at_club('$CLUB') limit 1));
EOF
} | $PSQL -d $DB 2>&1 | filter

echo "--- Q. coach removed by club can request again"
{ as_user $ADMIN; echo "select decide_coach_club((select coach_id from club_coach_requests('$CLUB') limit 1), '$CLUB', false);"; as_user $P1; cat <<EOF
\set ON_ERROR_STOP off
delete from coach_clubs where coach_id = my_coach_id() and club_id = '$CLUB';
insert into coach_clubs (coach_id, club_id) values (my_coach_id(), '$CLUB');
\echo '45. status after re-request -> pending'
select status from coach_clubs where coach_id = my_coach_id() and club_id = '$CLUB';
EOF
} | $PSQL -d $DB 2>&1 | filter

echo "--- R. coach privacy (review Phase 4)"
{ as_user $P2; cat <<EOF
\set ON_ERROR_STOP off
\echo '46. coach is pending (not listed): player reads rules -> 0 ; coach_availability -> 0'
select count(*) from availability_rules where club_id='$CLUB';
select count(*) from coach_availability((select id from coaches limit 1), '$CLUB', current_date, 7);
EOF
as_user $ADMIN; cat <<EOF
\echo '47. staff updates coach_clubs directly -> UPDATE 0 ; approves pending via RPC -> ok ; approving again -> ERROR not_pending'
update coach_clubs set status='approved' where club_id='$CLUB';
select decide_coach_club((select id from coaches limit 1), '$CLUB', true);
select decide_coach_club((select id from coaches limit 1), '$CLUB', true);
EOF
as_user $P2; cat <<EOF
\echo '48. now listed: player reads rules -> 2 ; availability over 14 days -> > 0'
select count(*) from availability_rules where club_id='$CLUB';
select count(*) > 0 from coach_availability((select id from coaches limit 1), '$CLUB', current_date, 14);
EOF
} | $PSQL -d $DB 2>&1 | filter

echo "--- S. exceptions per club; partial closure splits a window"
NEXT_TUE="(current_date + ((8 - extract(isodow from current_date)::int) % 7 + 1))::date"
{ as_user $P1; cat <<EOF
\set ON_ERROR_STOP off
delete from availability_exceptions where coach_id = my_coach_id();
delete from availability_rules where coach_id = my_coach_id();
insert into availability_rules (coach_id, club_id, weekday, start_time, end_time) values (my_coach_id(), '$CLUB', 1, '09:00', '17:00');
insert into availability_exceptions (coach_id, club_id, date, start_time, end_time, available) values (my_coach_id(), '$CLUB', $NEXT_TUE, '12:00', '13:00', false);
\echo '49. Tuesday 09-17 minus 12-13 -> expect 09:00-12:00 and 13:00-17:00'
select start_time, end_time from coach_availability(my_coach_id(), '$CLUB', $NEXT_TUE, 1);
\echo '50. extra hours at the OTHER club do not show at Batroun -> rows still 2'
insert into coach_clubs (coach_id, club_id) values (my_coach_id(), '$CLUB_B');
EOF
as_user $STAFF_B; cat <<EOF
select decide_coach_club((select id from coaches limit 1), '$CLUB_B', true);
EOF
as_user $P1; cat <<EOF
insert into availability_exceptions (coach_id, club_id, date, start_time, end_time, available) values (my_coach_id(), '$CLUB_B', $NEXT_TUE, '19:00', '21:00', true);
select count(*) from coach_availability(my_coach_id(), '$CLUB', $NEXT_TUE, 1);
select count(*) from coach_availability(my_coach_id(), '$CLUB_B', $NEXT_TUE, 1);
EOF
} | $PSQL -d $DB 2>&1 | filter

echo "--- T. match board"
$PSQL -q -d $DB -c "insert into auth.users (id, phone) values ('55555555-aaaa-4aaa-8aaa-555555555555','+9615') on conflict do nothing; insert into profiles (id, name) values ('55555555-aaaa-4aaa-8aaa-555555555555','Third') on conflict do nothing; update profiles set name='Player One' where id='$P1'; update profiles set name='Player Two' where id='$P2';"
P3=55555555-aaaa-4aaa-8aaa-555555555555
M=$({ as_user $P1; echo "select post_match('$CLUB','padel', now()+interval '2 day', now()+interval '2 day 90 min', 4, 6, 2, 'Need 2 for doubles', null);"; } | $PSQL -At -d $DB | tail -1)
{ as_user $P1; cat <<EOF
\set ON_ERROR_STOP off
\echo '51. organizer tries to join own match -> ERROR organizer_cannot_join ; direct insert into matches -> RLS'
select join_match('$M');
insert into matches (club_id, sport, organizer_id, start_at, players_needed) values ('$CLUB','padel',auth.uid(),now()+interval '3 day',2);
EOF
as_user $P2; cat <<EOF
\echo '52. player2 sees the match on the board with organizer name, joined 0 -> then joins -> joined 1, still open'
select organizer_name, joined, status from match_board('$CLUB', 14) where match_id='$M';
select join_match('$M');
select joined, status, i_joined from match_board('$CLUB', 14) where match_id='$M';
\echo '53. player2 sees participants (names) -> 2 rows'
select count(*) from match_participants('$M');
EOF
} | $PSQL -d $DB 2>&1 | filter
echo "54. two players race for the last place -> exactly one joins, match closes"
join() { { as_user $1; echo "begin; select join_match('$M'); select pg_sleep(1); commit;"; } | $PSQL -d $DB > /tmp/cb_j$2.log 2>&1; }
join $P3 1 & sleep 0.3; join $ADMIN 2 & wait
grep -h "ERROR" /tmp/cb_j1.log /tmp/cb_j2.log | sort | uniq -c
$PSQL -At -d $DB -c "select 'joined = '||count(*)||' (expect 2) ; status = '||(select status from matches where id='$M')||' (expect closed)' from match_players where match_id='$M'"
{ as_user $P2; cat <<EOF
\set ON_ERROR_STOP off
\echo '55. player2 leaves -> reopens with 1 joined ; outsider (not participant) cannot see participants -> 0'
select leave_match('$M');
select joined, status from match_board('$CLUB', 14) where match_id='$M';
EOF
as_user $STAFF_B; cat <<EOF
select count(*) from match_participants('$M');
EOF
as_user $P1; cat <<EOF
\echo '56. organizer closes -> closed ; outsider no longer sees it on the board -> 0 ; organizer still sees it -> 1'
select set_match_status('$M', 'closed');
EOF
as_user $STAFF_B; cat <<EOF
select count(*) from match_board('$CLUB', 14) where match_id='$M';
EOF
as_user $P1; cat <<EOF
select count(*) from match_board('$CLUB', 14) where match_id='$M';
EOF
} | $PSQL -d $DB 2>&1 | filter
$PSQL -q -d $DB -c "insert into bookings (id, club_id, court_id, player_id, start_at, end_at, status, source, created_by, price_usd, fee_usd) values ('99999999-9999-4999-8999-999999999999','$CLUB','$COURT3','$P1', (current_date + 9 + time '09:30') at time zone 'Asia/Beirut', (current_date + 9 + time '11:00') at time zone 'Asia/Beirut', 'confirmed','app','$P1',30,1)"
{ as_user $P1; cat <<EOF
\set ON_ERROR_STOP off
\echo '57. post linked to own confirmed booking -> club/time copied (t) ; player2 linking that booking -> ERROR booking_not_found'
select post_match(null,'padel',null,null,null,null,3,'from booking','99999999-9999-4999-8999-999999999999') as linked \gset
select club_id = '$CLUB' and start_at = (select start_at from bookings where id='99999999-9999-4999-8999-999999999999') from matches where id = :'linked';
EOF
as_user $P2; cat <<EOF
select post_match(null,'padel',null,null,null,null,3,'x','99999999-9999-4999-8999-999999999999');
EOF
} | $PSQL -d $DB 2>&1 | filter

echo "--- U. join approval, notifications, chat"
MA=$({ as_user $P1; echo "select post_match('$CLUB','padel', now()+interval '4 day', now()+interval '4 day 90 min', null, null, 1, 'approval match', null, 'approval');"; } | $PSQL -At -d $DB | tail -1)
{ as_user $P2; cat <<EOF
\set ON_ERROR_STOP off
\echo '58. join approval match -> pending ; board shows my_status pending, joined 0 ; participants hidden (not accepted) -> 0 ; chat insert -> RLS'
select join_match('$MA');
select my_status, joined, pending from match_board('$CLUB', 14) where match_id='$MA';
select count(*) from match_participants('$MA');
insert into match_messages (match_id, profile_id, body) values ('$MA', auth.uid(), 'hi');
EOF
as_user $P1; cat <<EOF
\echo '59. organizer has a join_request notification -> 1 ; sees pending participant -> 2 rows ; accepts -> match closes (needed 1)'
select count(*) from notifications where match_id='$MA' and kind='join_request';
select count(*) from match_participants('$MA');
select decide_join('$MA', '$P2', true);
select status from matches where id='$MA';
\echo '60. organizer writes a message -> ok ; player2 gets join_accepted + match_message notifications'
insert into match_messages (match_id, profile_id, body) values ('$MA', auth.uid(), 'See you at 7');
EOF
as_user $P2; cat <<EOF
select kind from notifications where match_id='$MA' order by created_at;
select count(*) from match_messages_list('$MA', null);
\echo '61. outsider cannot read messages -> 0 ; mark read -> unread 0'
EOF
as_user $STAFF_B; cat <<EOF
select count(*) from match_messages_list('$MA', null);
select count(*) from match_messages where match_id='$MA';
EOF
as_user $P2; cat <<EOF
select mark_notifications_read(null);
select count(*) from notifications where read_at is null;
EOF
as_user $P1; cat <<EOF
\echo '62. organizer cancels -> player2 gets match_cancelled'
select set_match_status('$MA', 'cancelled');
EOF
as_user $P2; cat <<EOF
select count(*) from notifications where match_id='$MA' and kind='match_cancelled';
EOF
} | $PSQL -d $DB 2>&1 | filter

echo "--- V. Phase 5 review fixes"
MB=$({ as_user $P1; echo "select post_match('$CLUB','padel', now()+interval '5 day', now()+interval '5 day 90 min', null, null, 2, 'two spots', null, 'approval');"; } | $PSQL -At -d $DB | tail -1)
{ as_user $P2; cat <<EOF
\set ON_ERROR_STOP off
\echo '63. player2 asks to join twice -> pending, pending (one request, one notification)'
select join_match('$MB'); select join_match('$MB');
EOF
as_user $P1; cat <<EOF
select count(*) from notifications where match_id='$MB' and kind='join_request';
EOF
as_user $P3; cat <<EOF
\echo '64. player3 (pending too) cannot read player2 participation -> 0 ; cannot resolve player2 name -> 0'
select join_match('$MB');
select count(*) from match_players where match_id='$MB' and profile_id='$P2';
select count(*) from player_names(array['$P2'::uuid]);
EOF
as_user $P1; cat <<EOF
\echo '65. organizer resolves applicant names -> 2 ; accepts player2 ; replay of player2 join -> accepted, still open (needed 2)'
select count(*) from player_names(array['$P2'::uuid,'$P3'::uuid]);
select decide_join('$MB','$P2', true);
EOF
as_user $P2; cat <<EOF
select join_match('$MB');
select status from match_board('$CLUB', 14) where match_id='$MB';
EOF
as_user $P1; cat <<EOF
\echo '66. organizer closes manually ; player2 leaves -> stays closed'
select set_match_status('$MB','closed');
EOF
as_user $P2; cat <<EOF
select leave_match('$MB');
EOF
as_user $P1; cat <<EOF
select status from match_board('$CLUB', 14) where match_id='$MB';
\echo '67. organizer cancels ; accepting player3 pending request -> ERROR match_closed'
select set_match_status('$MB','cancelled');
select decide_join('$MB','$P3', true);
\echo '68. linked booking: sport mismatch -> ERROR ; staff moves booking -> match time follows + booking_moved notice ; cancel -> unlinked + notice'
select post_match(null,'tennis',null,null,null,null,2,'x','99999999-9999-4999-8999-999999999999');
EOF
as_user $ADMIN; cat <<EOF
select move_booking('99999999-9999-4999-8999-999999999999','$COURT3', (current_date + 9 + time '12:30') at time zone 'Asia/Beirut', (current_date + 9 + time '14:00') at time zone 'Asia/Beirut');
EOF
as_user $P1; cat <<EOF
select start_at = (current_date + 9 + time '12:30') at time zone 'Asia/Beirut' from matches where booking_id='99999999-9999-4999-8999-999999999999';
select cancel_booking('99999999-9999-4999-8999-999999999999');
select booking_id is null from matches where note='from booking';
select kind from notifications where profile_id=auth.uid() and kind in ('booking_moved','booking_unlinked') order by created_at;
EOF
} | $PSQL -d $DB 2>&1 | filter
echo "69. two concurrent email claims -> disjoint batches"
$PSQL -q -d $DB -c "update auth.users set email = 'u' || phone || '@example.com'; update profiles set email_notifications = true;"
{ as_service; echo "select count(*) from claim_notifications_to_email(50);"; } | $PSQL -At -d $DB 2>&1 | tail -1 | sed 's/^/first claim: /'
{ as_service; echo "select count(*) from claim_notifications_to_email(50);"; } | $PSQL -At -d $DB 2>&1 | tail -1 | sed 's/^/second claim (expect 0): /'

echo "--- W. linked match vs concurrency (review Phase 5 round 2)"
BK=88888888-8888-4888-8888-888888888888
$PSQL -q -d $DB -c "insert into bookings (id, club_id, court_id, player_id, start_at, end_at, status, source, created_by, price_usd, fee_usd) values ('$BK','$CLUB','$COURT2','$P1', (current_date + 10 + time '09:30') at time zone 'Asia/Beirut', (current_date + 10 + time '11:00') at time zone 'Asia/Beirut', 'confirmed','app','$P1',30,1)"
echo "70. two concurrent post_match on one booking -> one match, other booking_already_posted"
pm() { { as_user $P1; echo "begin; select post_match(null,'padel',null,null,null,null,3,'race $2','$BK'); select pg_sleep(1); commit;"; } | $PSQL -d $DB > /tmp/cb_pm$2.log 2>&1; }
pm x 1 & sleep 0.3; pm x 2 & wait
grep -h "ERROR" /tmp/cb_pm1.log /tmp/cb_pm2.log | sort | uniq -c
$PSQL -At -d $DB -c "select 'live matches on booking = '||count(*)||' (expect 1)' from matches where booking_id='$BK' and status<>'cancelled'"
echo "71. cancel the match, repost -> allowed (index is partial)"
{ as_user $P1; echo "select set_match_status((select id from matches where booking_id='$BK'),'cancelled'); select post_match(null,'padel',null,null,null,null,3,'repost','$BK') is not null;"; } | $PSQL -At -d $DB 2>&1 | tail -1
echo "72. post_match races booking cancellation -> either booking_not_found, or match created then unlinked by trigger (never a live link to a cancelled booking)"
{ as_user $P1; echo "select set_match_status((select id from matches where booking_id='$BK' and status<>'cancelled'),'cancelled');"; } | $PSQL -q -d $DB
{ as_user $P1; echo "begin; select cancel_booking('$BK'); select pg_sleep(1); commit;"; } | $PSQL -d $DB > /tmp/cb_cx.log 2>&1 &
sleep 0.3; { as_user $P1; echo "select post_match(null,'padel',null,null,null,null,3,'late post','$BK');"; } | $PSQL -d $DB > /tmp/cb_lp.log 2>&1; wait
grep -h "ERROR" /tmp/cb_lp.log | sort | uniq -c
$PSQL -At -d $DB -c "select 'matches still linked to cancelled booking = '||count(*)||' (expect 0)' from matches m join bookings b on b.id=m.booking_id where b.id='$BK' and b.status<>'confirmed' and m.status<>'cancelled'"

echo "--- X. Phase 6 (a): sports table, geography, add_town"
{ as_user $P1; cat <<EOF
\set ON_ERROR_STOP off
\echo '73. reference data readable: 7 sports, 9 governorates, 26 districts, towns > 250, Keserwan-Jbeil legacy parent = mount-lebanon'
select (select count(*) from sports), (select count(*) from governorates), (select count(*) from districts), (select count(*) > 250 from towns), (select legacy_parent from governorates where code='keserwan-jbeil');
\echo '74. player cannot add a town -> ERROR forbidden ; cannot insert directly -> 0 rows'
select add_town('batroun','Newtown');
insert into towns (district_code, name_en) values ('batroun','Hack');
select count(*) from towns where name_en='Hack';
EOF
as_user $STAFF_B; cat <<EOF
\echo '75. staff adds a town -> id ; same name different case -> same id, still one row ; bad district -> ERROR'
select add_town('batroun','Bziza', 'بزيزا') as t1 \gset
select add_town('batroun','  bziza ') = :'t1';
select count(*) from towns where district_code='batroun' and lower(name_en)='bziza';
select add_town('nowhere','X');
\echo '76a. staff of another club cannot set this club -> ERROR forbidden'
select update_club_settings('$CLUB','08:00','23:00',30,60,180,6,10,14,'', (select id from towns where name_en='Batroun'), 34.2553, 35.6586);
EOF
as_user $ADMIN; cat <<EOF
\echo '76. admin/staff sets club town + coords; bad town -> ERROR ; areas() has 9 entries'
select update_club_settings('$CLUB','08:00','23:00',30,60,180,6,10,14,'', (select id from towns where name_en='Batroun'), 34.2553, 35.6586);
select t.name_en, d.name_en, g.name_en from clubs c join towns t on t.id=c.town_id join districts d on d.code=t.district_code join governorates g on g.code=d.governorate_code where c.id='$CLUB';
select update_club_settings('$CLUB','08:00','23:00',30,60,180,6,10,14,'', '00000000-0000-4000-8000-000000000000', null, null);
select jsonb_array_length(areas());
\echo '77. club_sports derived from active courts: add football pitch -> {football,padel}; deactivate -> {padel}'
insert into courts (club_id, name, sport, sort) values ('$CLUB','Pitch 1','football',99);
select club_sports('$CLUB');
update courts set active=false where name='Pitch 1';
select club_sports('$CLUB');
EOF
} | $PSQL -d $DB 2>&1 | filter

echo "--- Y. Phase 6 (b): discovery"
{ as_user $P1; cat <<EOF
\set ON_ERROR_STOP off
\echo '78. club_discovery all Lebanon -> batroun club with town Batroun / North, sports contain padel, price_from 20'
select slug, town, governorate, 'padel' = any(sports), price_from, next_free_court_id is not null or next_free_at is null from club_discovery();
\echo '79. filters: district batroun -> 1+ ; district tyre -> 0 ; sport football -> 0 (pitch inactive) ; query "bat" -> 1+ ; query arabic -> 1+'
select count(*) from club_discovery(null, null, 'batroun');
select count(*) from club_discovery(null, null, 'tyre');
select count(*) from club_discovery('football');
select count(*) > 0 from club_discovery(null, null, null, 'bat');
select count(*) > 0 from club_discovery(null, null, null, 'البترون');
EOF
} | $PSQL -d $DB 2>&1 | filter
$PSQL -q -d $DB -c "update clubs set open_time='00:00', close_time='24:00', slot_minutes=30, min_booking_minutes=30, max_booking_minutes=180 where slug='other'; delete from price_rules where club_id=(select id from clubs where slug='other');"
{ as_user $P1; cat <<EOF
\echo '80. next_free_slot (other club, open 24h, 30-min grid): slot found, on grid, >= now ; no price rules -> price_from null  [fails only if Beirut time >= 23:25]'
select start_at >= now() and extract(minute from start_at at time zone 'Asia/Beirut')::int % 30 = 0 from next_free_slot((select id from clubs where slug='other'));
select next_free_at is not null and price_from is null from club_discovery(null,null,null,'other');
EOF
} | $PSQL -d $DB 2>&1 | filter
$PSQL -q -d $DB -c "insert into price_rules (club_id, weekday_mask, start_time, end_time, price_usd) select id, 127, '00:00', '24:00', 10 from clubs where slug='other';"
{ as_user $P1; cat <<EOF
\echo '80b. book that slot -> next free moves later'
select start_at as nf1 from next_free_slot((select id from clubs where slug='other')) \gset
select booking_id from hold_slot((select id from clubs where slug='other'), (select id from courts where name='Other 1'), :'nf1', :'nf1'::timestamptz + interval '30 min') \gset
select start_at > :'nf1' from next_free_slot((select id from clubs where slug='other'));
select release_hold(:'booking_id');
\echo '81. open_matches excludes my own matches and non-open ones; includes others'' open future matches'
select count(*) from open_matches() where organizer_name = 'Player One';
EOF
as_user $P2; cat <<EOF
select count(*) > 0 from open_matches('padel');
EOF
} | $PSQL -d $DB 2>&1 | filter

echo "--- Z. public browsing (Phase 6 review) — anon sees availability and prices, never names, holds or matches"
check  anon "82a anon club_discovery returns clubs"        "select count(*) > 0 from club_discovery();" t
check  anon "82b anon areas() has 9 governorates"           "select jsonb_array_length(areas());" 9
check  anon "82c public_occupancy has no id/mine/status"    "select count(*) from information_schema.columns where table_name='public_occupancy' and column_name in ('id','mine','status','player_id');" 0
check  anon "82d anon quote_price works"                    "select quote_price('$COURT', (current_date + 12 + time '10:00') at time zone 'Asia/Beirut', (current_date + 12 + time '11:00') at time zone 'Asia/Beirut');" 20.00
check  anon "82e anon reads town geography columns"         "select count(*) > 300 from towns;" t
denied anon "82f anon cannot read towns.created_by"         "select created_by from towns limit 1;"
denied anon "82g anon cannot read towns.*"                  "select * from towns limit 1;"
denied anon "83a anon occupancy"                            "select count(*) from occupancy;"
denied anon "83b anon hold_slot"                            "select * from hold_slot('$CLUB','$COURT', (current_date + 12 + time '10:00') at time zone 'Asia/Beirut', (current_date + 12 + time '11:00') at time zone 'Asia/Beirut');"
denied anon "83c anon open_matches"                         "select count(*) from open_matches();"
denied anon "83d anon player_names"                         "select count(*) from player_names(array['$P1'::uuid]);"
denied anon "83e anon profiles"                             "select count(*) from profiles;"
denied anon "83f anon my_agenda"                            "select count(*) from my_agenda();"
denied anon "83g anon match_messages"                       "select count(*) from match_messages;"
denied anon "83h anon notifications"                        "select count(*) from notifications;"
check  $P1  "83i player cannot read towns.created_by either" "select count(*) from information_schema.column_privileges where table_name='towns' and column_name='created_by' and grantee in ('anon','authenticated') and privilege_type='SELECT';" 0

echo "--- AA. my_agenda"
check $P1 "84a P1 agenda has bookings"                      "select count(*) > 0 from my_agenda() where kind='booking';" t
check $P1 "84b P1 agenda has matches"                       "select count(*) > 0 from my_agenda() where kind='match';" t
check $P1 "84c P1's matches are all organized by P1"        "select count(*) from my_agenda() where kind='match' and role <> 'organizer';" 0
# P3's earlier request was cleared when that organizer made his match private (section 66), so make a live one
MP3=$({ as_user $P1; echo "select post_match('$CLUB','padel', now()+interval '5 day', now()+interval '5 day 90 min', null, null, 2, 'agenda pending', null, 'approval');"; } | $PSQL -At -d $DB | tail -1)
{ as_user $P3; echo "select join_match('$MP3');"; } | $PSQL -q -d $DB >/dev/null
check $P3 "85a P3 agenda: one accepted"                     "select count(*) from my_agenda() where role='accepted';" 1
check $P3 "85b P3 agenda: one pending"                      "select count(*) from my_agenda() where role='pending';" 1
check $P3 "85c P3 agenda: no bookings (P3 never booked)"    "select count(*) from my_agenda() where kind='booking';" 0

echo "--- AB. public_occupancy scope"
$PSQL -q -d $DB -c "insert into clubs (name, slug, active) values ('Closed Club','closed', false); insert into courts (club_id, name, sport) select id, 'C1', 'padel' from clubs where slug='closed';
insert into bookings (club_id, court_id, player_id, start_at, end_at, status, source, created_by, price_usd, fee_usd) select c.id, k.id, '$P1', (current_date + 2 + time '10:00') at time zone 'Asia/Beirut', (current_date + 2 + time '11:00') at time zone 'Asia/Beirut', 'confirmed','app','$P1',10,1 from clubs c join courts k on k.club_id=c.id where c.slug='closed';
insert into bookings (club_id, court_id, player_id, start_at, end_at, status, source, created_by, price_usd, fee_usd) values ('$CLUB','$COURT','$P1', (current_date - 30 + time '10:00') at time zone 'Asia/Beirut', (current_date - 30 + time '11:00') at time zone 'Asia/Beirut', 'confirmed','app','$P1',10,1);
insert into bookings (club_id, court_id, player_id, start_at, end_at, status, source, created_by, price_usd, fee_usd) values ('$CLUB','$COURT','$P1', (current_date + 400 + time '10:00') at time zone 'Asia/Beirut', (current_date + 400 + time '11:00') at time zone 'Asia/Beirut', 'confirmed','app','$P1',10,1);" 2>&1 | grep -v INSERT
check service "86a fixtures inserted"                       "select (select count(*) from bookings where club_id=(select id from clubs where slug='closed')) + (select count(*) from bookings where court_id='$COURT' and (start_at < now() - interval '20 day' or start_at > now() + interval '300 day'));" 3
check anon    "86b inactive club hidden"                    "select count(*) from public_occupancy where club_id = (select id from clubs where slug='closed');" 0
check anon    "86c past (30 days ago) hidden"               "select count(*) from public_occupancy where start_at < now() - interval '2 day';" 0
check anon    "86d beyond window (400 days) hidden"         "select count(*) from public_occupancy where start_at > now() + interval '100 day';" 0
check anon    "86e within window visible"                   "select count(*) > 0 from public_occupancy where club_id='$CLUB';" t

echo "--- INVARIANTS (re-asserted at the end of the run)"
check service "I1 no two live bookings overlap on one court"  "select count(*) from bookings a join bookings b on a.court_id=b.court_id and a.id<b.id and a.period && b.period where a.status in ('confirmed','pending') and b.status in ('confirmed','pending');" 0
check service "I2 at most one live match per booking"         "select count(*) from (select booking_id from matches where booking_id is not null and status<>'cancelled' group by 1 having count(*)>1) x;" 0
check service "I3 no live match linked to a non-confirmed booking" "select count(*) from matches m join bookings b on b.id=m.booking_id where m.status<>'cancelled' and b.status<>'confirmed';" 0
check service "I4 every live hold has a pending payment"      "select count(*) from bookings b where b.status='pending' and not exists (select 1 from payments p where p.booking_id=b.id and p.status='pending');" 0
check service "I5 no player holds two live slots"             "select count(*) from (select player_id from bookings where status='pending' and hold_expires_at>now() group by 1 having count(*)>1) x;" 0
check service "I6 anon can execute only the public RPCs (effective, incl. PUBLIC)" "select string_agg(distinct p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e') and has_function_privilege('anon', p.oid, 'EXECUTE');" "areas,club_day_slots,club_discovery,club_sports,next_free_slot,quote_price"
$PSQL -q -d $DB -c "create function _probe_fn() returns int language sql as 'select 1';"
denied anon    "I6b a new function without grants is not executable by anon" "select _probe_fn();"
check  service "I6c ...nor by authenticated (explicit grant needed)" "select has_function_privilege('authenticated', '_probe_fn()', 'EXECUTE');" f
$PSQL -q -d $DB -c "drop function _probe_fn();"
denied anon    "Q1 anon one-year quote rejected"                  "select quote_price('$COURT', (current_date + 12 + time '10:00') at time zone 'Asia/Beirut', (current_date + 377 + time '10:00') at time zone 'Asia/Beirut');"
denied anon    "Q2 anon quote on inactive court rejected"        "select quote_price((select id from courts where name='Pitch 1'), (current_date + 12 + time '10:00') at time zone 'Asia/Beirut', (current_date + 12 + time '11:00') at time zone 'Asia/Beirut');"
denied anon    "Q3 anon quote on inactive club rejected"         "select quote_price((select id from courts where name='C1'), (current_date + 12 + time '10:00') at time zone 'Asia/Beirut', (current_date + 12 + time '11:00') at time zone 'Asia/Beirut');"
denied anon    "Q4 anon quote with end before start rejected"    "select quote_price('$COURT', (current_date + 12 + time '11:00') at time zone 'Asia/Beirut', (current_date + 12 + time '10:00') at time zone 'Asia/Beirut');"
denied anon    "Q5 anon quote above club max (4 h) rejected"     "select quote_price('$COURT', (current_date + 12 + time '10:00') at time zone 'Asia/Beirut', (current_date + 12 + time '14:00') at time zone 'Asia/Beirut');"
denied anon    "Q6 expire_stale_holds not callable by anon"      "select expire_stale_holds('$COURT');"
denied anon    "Q7 lock_courts not callable by anon"             "select lock_courts(array['$COURT'::uuid]);"
check service "I7 anon can read only the public tables"      "select string_agg(table_name, ',' order by table_name) from information_schema.tables t where t.table_schema='public' and has_table_privilege('anon', quote_ident(t.table_schema)||'.'||quote_ident(t.table_name), 'SELECT');" "clubs,courts,districts,governorates,price_rules,public_occupancy,sports"
# club_media is read column by column instead, so the uploader's identity stays private
check service "I7b and of a club's images, only the public columns" "select string_agg(column_name, ',' order by column_name) from information_schema.columns c where c.table_name='club_media' and has_column_privilege('anon','club_media',column_name,'SELECT');" "caption,club_id,external_url,height,id,kind,path,sort,width"
check service "I8 anon cannot write any table"                "select count(*) from information_schema.tables t where t.table_schema='public' and (has_table_privilege('anon', quote_ident(t.table_schema)||'.'||quote_ident(t.table_name), 'INSERT') or has_table_privilege('anon', quote_ident(t.table_schema)||'.'||quote_ident(t.table_name), 'UPDATE') or has_table_privilege('anon', quote_ident(t.table_schema)||'.'||quote_ident(t.table_name), 'DELETE'));" 0
check service "I9 anon reads towns geography columns only"    "select string_agg(column_name, ',' order by column_name) from information_schema.columns c where table_name='towns' and has_column_privilege('anon', 'public.towns', column_name, 'SELECT');" "created_at,district_code,id,lat,lng,name_ar,name_en,seeded"


echo "--- AC. update_match"
ME=$({ as_user $P1; echo "select post_match('$CLUB','padel', now()+interval '6 day', now()+interval '6 day 90 min', null, null, 4, 'edit me', null, 'open');"; } | $PSQL -At -d $DB | tail -1)
{ as_user $P2; echo "select join_match('$ME');"; } | $PSQL -q -d $DB >/dev/null
{ as_user $P3; echo "select join_match('$ME');"; } | $PSQL -q -d $DB >/dev/null
denied $P2 "87a non-organizer cannot edit"                  "select update_match('$ME', 3, null, null, 'x', 'open');"
denied $P1 "87b cannot go below accepted count (2)"        "select update_match('$ME', 1, null, null, 'x', 'open');"
check  $P1 "87c organizer edits to 3 players, approval"    "select update_match('$ME', 3, 4, 6, 'now three', 'approval'); select players_needed||'/'||join_mode||'/'||level_min||'-'||level_max||'/'||note from matches where id='$ME';" "3/approval/4-6/now three"
check  $P1 "87d edit to 2 players -> closes as full"       "select update_match('$ME', 2, null, null, null, 'open'); select status||'/'||closed_reason from matches where id='$ME';" "closed/full"
check  $P1 "87e edit back to 3 -> reopens"                 "select update_match('$ME', 3, null, null, null, 'open'); select status||'/'||coalesce(closed_reason,'-') from matches where id='$ME';" "open/-"
check  $P1 "87f manual close then edit stays closed"       "select set_match_status('$ME','closed'); select update_match('$ME', 4, null, null, null, 'open'); select status||'/'||closed_reason from matches where id='$ME';" "closed/organizer"


echo "--- AD. club_day_slots"
$PSQL -q -d $DB -c "update clubs set open_time='08:00', close_time='23:00', slot_minutes=30, min_booking_minutes=60, max_booking_minutes=180 where slug='batroun';"
D12=$($PSQL -At -d $DB -c "select ((now() at time zone 'Asia/Beirut')::date + 12)::text")
check anon "88a day slots: batroun court1 has slots on day+12"     "select count(*) > 0 from club_day_slots('$D12') where court_id='$COURT';" t
check anon "88b first slot is 08:00 local, free run 180 (max)"     "select to_char(start_at at time zone 'Asia/Beirut','HH24:MI')||'/'||free_minutes from club_day_slots('$D12') where court_id='$COURT' order by start_at limit 1;" "08:00/180"
check anon "88c last slot starts 22:00 (close 23:00, min 60) run 60" "select to_char(start_at at time zone 'Asia/Beirut','HH24:MI')||'/'||free_minutes from club_day_slots('$D12') where court_id='$COURT' order by start_at desc limit 1;" "22:00/60"
check anon "88d sport filter football -> 0 (pitch inactive)"        "select count(*) from club_day_slots('$D12','football');" 0
check anon "88e district tyre -> 0"                                 "select count(*) from club_day_slots('$D12', null, null, 'tyre');" 0
check anon "88f beyond booking window (day+20) -> 0 rows"           "select count(*) from club_day_slots(((now() at time zone 'Asia/Beirut')::date + 20)) where slug='batroun';" 0
# boundary fixture: 'other' club is open 00:00–24:00 on a 30-min grid (set in test 80) with a 20-day window, so on the
# last day the slots before the rolling cutoff are exactly the half-hours from 00:00 up to the current Beirut time.
$PSQL -q -d $DB -c "update clubs set booking_window_days = 20 where slug='other';"
check anon "88f2 last day: no slot starts after the rolling cutoff"  "select count(*) from club_day_slots(((now() at time zone 'Asia/Beirut')::date + 20)) where slug='other' and start_at > now() + interval '20 days';" 0
check anon "88f3 last day: every half-hour up to the cutoff is offered (count = floor(local minutes/30)+1, per court)" "select count(*) = (floor(extract(epoch from (now() at time zone 'Asia/Beirut')::time) / 1800)::int + 1) * (select count(*) from courts where club_id=(select id from clubs where slug='other') and active) from club_day_slots(((now() at time zone 'Asia/Beirut')::date + 20)) where slug='other';" t
check anon "88g yesterday -> 0 rows"                                "select count(*) from club_day_slots((current_date - 1)::date);" 0
{ as_user $P1; echo "select booking_id from hold_slot('$CLUB','$COURT', ('$D12'::date + time '10:00') at time zone 'Asia/Beirut', ('$D12'::date + time '11:30') at time zone 'Asia/Beirut');"; } | $PSQL -q -d $DB > /dev/null
check anon "88h after a 10:00–11:30 hold: 09:00 run 60, 09:30 gone (needs 60), 11:30 present" "select string_agg(to_char(start_at at time zone 'Asia/Beirut','HH24:MI')||'/'||free_minutes, ',' order by start_at) from club_day_slots('$D12') where court_id='$COURT' and start_at >= (('$D12'::date + time '09:00') at time zone 'Asia/Beirut') and start_at <= (('$D12'::date + time '11:30') at time zone 'Asia/Beirut');" "09:00/60,11:30/180"


echo "--- AE. booking-window boundary: discovery agrees with hold_slot"
D14=$($PSQL -At -d $DB -c "select ((now() at time zone 'Asia/Beirut')::date + 14)::text")
check anon "89a last day (batroun, 14-day window): no start after now()+14d" "select count(*) from club_day_slots('$D14') where slug='batroun' and start_at > now() + interval '14 days';" 0
# batroun: 08:00–23:00, 30-min grid, min 60 → starts are half-hours 16..44 of the day, and on the last day only those <= local now
check anon "89b last day (batroun): count = active courts × starts between 08:00 and min(now, 22:00)" "select count(*) = (select count(*) from courts where club_id='$CLUB' and active) * greatest(0, least(floor(extract(epoch from (now() at time zone 'Asia/Beirut')::time) / 1800)::int, 44) - 16 + 1) from club_day_slots('$D14') where slug='batroun';" t
check $P1  "89c hold at the last listed start succeeds (true when nothing is listed yet today)" "select coalesce((select (hold_slot('$CLUB', court_id, start_at, start_at + interval '60 min')).booking_id is not null from (select court_id, start_at from club_day_slots('$D14') where court_id='$COURT' order by start_at desc limit 1) s), true);" t


echo "--- AE. player levels (Phase 8)"
check  $P1 "90a set tennis 7 and padel 3 -> both stored"            "select set_player_level('tennis', 7); select set_player_level('padel', 3); select string_agg(sport||'='||level, ',' order by sport) from my_levels();" "padel=3,tennis=7"
denied $P1 "90b level 11 rejected"                                 "select set_player_level('padel', 11);"
denied $P1 "90c level 0 rejected"                                  "select set_player_level('padel', 0);"
check  $P1 "90d clear padel -> only tennis remains"                "select set_player_level('padel', null); select string_agg(sport||'='||level, ',') from my_levels();" "tennis=7"
check  $P2 "90e player2 cannot read player1's levels"              "select count(*) from player_levels where profile_id='$P1';" 0
denied $P2 "90f player2 cannot insert a level for player1"         "insert into player_levels (profile_id, sport, level) values ('$P1','padel',5);"
check  service "90g level_group boundaries"                        "select level_group(1)||','||level_group(3)||','||level_group(4)||','||level_group(6)||','||level_group(7)||','||level_group(10);" "beginner,beginner,intermediate,intermediate,advanced,advanced"
denied $P1 "90h post_match with min > max rejected"                "select post_match('$CLUB','tennis', now()+interval '7 day', now()+interval '7 day 1 hour', 6, 4, 2, null, null, 'open');"
denied $P1 "90i post_match with only min rejected"                 "select post_match('$CLUB','tennis', now()+interval '7 day', now()+interval '7 day 1 hour', 4, null, null, 2, null, null, 'open');"
MR=$({ as_user $P1; echo "select post_match('$CLUB','tennis', now()+interval '7 day', now()+interval '7 day 1 hour', 4, 6, 2, 'ranged', null, 'open');"; } | $PSQL -At -d $DB | tail -1)
ML=$({ as_user $P1; echo "select post_match('$CLUB','tennis', now()+interval '7 day 2 hour', now()+interval '7 day 3 hour', null, null, 2, 'all levels', null, 'open');"; } | $PSQL -At -d $DB | tail -1)
$PSQL -q -d $DB -c "update matches set level='advanced', level_min=null, level_max=null where id='$ML';"   # turn the second into a legacy post (7–10)
check $P2 "90j player2 with tennis 5: fit=mine shows the 4–6 match, hides the legacy advanced one" "select set_player_level('tennis', 5); select string_agg(note, ',' order by note) from open_matches('tennis', 'mine');" "ranged"
check $P2 "90k legacy post reports 7–10 and legacy flag"            "select level_min||'-'||level_max||'/'||level_legacy from open_matches('tennis') where match_id='$ML';" "7-10/true"
check $P2 "90l my_level is returned for the match's sport"         "select my_level from open_matches('tennis') where match_id='$MR';" 5
check $P3 "90m player3 with no tennis level sees both with fit=mine" "select count(*) from open_matches('tennis', 'mine') where match_id in ('$MR','$ML');" 2
check $P1 "90n organizer edits range to 3–8 -> stored"             "select update_match('$MR', 2, 3, 8, 'ranged', 'open'); select level_min||'-'||level_max from matches where id='$MR';" "3-8"
check $P2 "90o participants show numeric level for the sport"      "select join_match('$MR'); select level from match_participants('$MR') where profile_id='$P2';" 5
check service "90p badminton is a sport"                           "select count(*) from sports where code='badminton';" 1


echo "--- AF. delete activity / chat, open a booking"
$PSQL -q -d $DB -c "insert into notifications (profile_id, kind, body) values ('$P1','test','a'),('$P1','test','b'),('$P2','test','c');"
NID=$($PSQL -At -d $DB -c "select id from notifications where profile_id='$P1' and kind='test' limit 1")
{ as_user $P2; echo "select delete_notification('$NID');"; } | $PSQL -q -d $DB >/dev/null
check service "91a player2 cannot delete player1's notification (still there)" "select count(*) from notifications where id='$NID';" 1
{ as_user $P1; echo "select delete_notification('$NID'); select clear_notifications();"; } | $PSQL -q -d $DB >/dev/null
check service "91b player1 deletes one and clears the rest -> none of his, player2's untouched" "select (select count(*) from notifications where profile_id='$P1')||'/'||(select count(*) from notifications where profile_id='$P2' and kind='test');" "0/1"
# fixture: a finished match P1 organised, P2 accepted, one message each
PM=$($PSQL -At -q -d $DB -c "insert into matches (club_id, sport, organizer_id, start_at, end_at, players_needed, status) values ('$CLUB','padel','$P1', now() - interval '2 day', now() - interval '2 day' + interval '90 min', 1, 'closed') returning id" | head -1)
$PSQL -q -d $DB -c "insert into match_players (match_id, profile_id, status) values ('$PM','$P2','accepted'); insert into match_messages (match_id, profile_id, body) values ('$PM','$P1','from p1'), ('$PM','$P2','from p2');" > /dev/null
MSG=$($PSQL -At -q -d $DB -c "select id from match_messages where match_id='$PM' and profile_id='$P2'" | head -1)
denied $P1 "91c player1 cannot delete player2's message"           "select delete_match_message('$MSG');"
check  $P2 "91d player2 deletes own message -> listed as deleted with empty body" "select delete_match_message('$MSG'); select deleted||'/'||coalesce(body,'') from match_messages_list((select match_id from match_messages where id='$MSG'), null) where id='$MSG';" "true/"
denied $P2 "91e deleting it again -> not_found"                     "select delete_match_message('$MSG');"
BK2=$({ as_user $P1; echo "select booking_id from hold_slot('$CLUB','$COURT3', (current_date + 11 + time '09:00') at time zone 'Asia/Beirut', (current_date + 11 + time '10:30') at time zone 'Asia/Beirut');"; } | $PSQL -At -d $DB | tail -1)
{ as_service; echo "select confirm_payment((select id from payments where booking_id='$BK2'), 'ref-bk2', (select total_usd from payments where booking_id='$BK2'));"; } | $PSQL -q -d $DB >/dev/null
check $P1 "91f booking is private: booking_match -> no row"        "select count(*) from booking_match('$BK2');" 0
check $P1 "91g open it to players (range 4–6, approval) -> public"  "select post_match(null, 'padel', null, null, 4, 6, 2, 'open from booking', '$BK2', 'approval'); select status||'/'||level_min||'-'||level_max||'/'||join_mode from booking_match('$BK2');" "open/4-6/approval"
check $P2 "91h player2 cannot see it via booking_match (not their booking)" "select count(*) from booking_match('$BK2');" 0
check $P1 "91i make private again -> no live match"                 "select set_match_status((select match_id from booking_match('$BK2')), 'cancelled'); select count(*) from booking_match('$BK2');" 0

# --- going private with players already in (Paul, 11 Nov): they stay, the match leaves everyone else's board
P4=66666666-aaaa-4aaa-8aaa-666666666666
$PSQL -q -d $DB -c "insert into auth.users (id, phone) values ('$P4','+9616') on conflict do nothing; insert into profiles (id, name) values ('$P4','Fourth') on conflict do nothing;"
PV=$({ as_user $P1; echo "select post_match('$CLUB','padel', now()+interval '7 day', now()+interval '7 day 90 min', null, null, 3, 'going private later', null, 'approval');"; } | $PSQL -At -d $DB | tail -1)
{ as_user $P2; echo "select join_match('$PV');"; } | $PSQL -q -d $DB >/dev/null
{ as_user $P1; echo "select decide_join('$PV','$P2', true);"; } | $PSQL -q -d $DB >/dev/null
{ as_user $P3; echo "select join_match('$PV');"; } | $PSQL -q -d $DB >/dev/null
$PSQL -q -d $DB -c "insert into match_messages (match_id, profile_id, body) values ('$PV','$P1','see you there');" >/dev/null
check $P2 "92a before: the accepted player sees it"                 "select count(*) from match_board(null, 30) where match_id='$PV';" 1
check $P4 "92b before: a stranger sees it on the open board"        "select count(*) from open_matches('padel') where match_id='$PV';" 1
{ as_user $P1; echo "select set_match_status('$PV','closed');"; } | $PSQL -q -d $DB >/dev/null
check service "92c organizer makes it private -> closed by the organizer, not cancelled" "select status||'/'||closed_reason from matches where id='$PV';" "closed/organizer"
check service "92d the accepted player is still in"                 "select status from match_players where match_id='$PV' and profile_id='$P2';" "accepted"
check $P4 "92e after: strangers no longer see it"                   "select count(*) from open_matches('padel') where match_id='$PV';" 0
check $P2 "92f after: the player who joined keeps it, still accepted" "select count(*)||'/'||coalesce(max(my_status),'-') from match_board(null, 30) where match_id='$PV';" "1/accepted"
check $P2 "92g after: he can still read the chat"                   "select count(*) from match_messages_list('$PV', null);" 1
check service "92h the waiting list is cleared, so he may ask again later" "select count(*) from match_players where match_id='$PV' and profile_id='$P3';" 0
check $P3 "92i the declined player no longer sees the match"        "select count(*) from match_board(null, 30) where match_id='$PV';" 0
check $P3 "92j and he was told why"                                 "select count(*) from notifications where match_id='$PV' and profile_id='$P3' and kind='join_declined';" 1
{ as_user $P1; echo "select set_match_status('$PV','open');"; } | $PSQL -q -d $DB >/dev/null
check $P4 "92k opened to players again -> strangers see it again"   "select count(*) from open_matches('padel') where match_id='$PV';" 1

# --- a private match is private everywhere, not only on the board (0044)
{ as_user $P1; echo "select set_match_status('$PV','closed');"; } | $PSQL -q -d $DB >/dev/null
check $P4 "92l stranger cannot read the row itself"                 "select count(*) from matches where id='$PV';" 0
check $P3 "92m former requester cannot read the row either"         "select count(*) from matches where id='$PV';" 0
check $P2 "92n the player in it still can"                          "select count(*) from matches where id='$PV';" 1
check $P1 "92o the organizer still can"                             "select count(*) from matches where id='$PV';" 1
check $P4 "92p stranger gets no participant list"                   "select count(*) from match_participants('$PV');" 0
check $P4 "92q stranger cannot read the chat"                       "select count(*) from match_messages_list('$PV', null);" 0
check $P4 "92r stranger cannot read who is in it from the table"    "select count(*) from match_players where match_id='$PV';" 0
denied $P4 "92s stranger cannot join a private match"               "select join_match('$PV');"
check $ADMIN "92t an admin can still see it"                        "select count(*) from matches where id='$PV';" 1

# cancellation is final: not even through 'closed' (the two-step bypass)
{ as_user $P1; echo "select set_match_status('$PV','cancelled');"; } | $PSQL -q -d $DB >/dev/null
denied $P1 "92u cancelled -> closed is refused"                     "select set_match_status('$PV','closed');"
denied $P1 "92v cancelled -> open is refused"                       "select set_match_status('$PV','open');"
check service "92w it is still cancelled"                           "select status from matches where id='$PV';" "cancelled"

# joining and going private take the same row lock, so one cannot slip past the other
PL=$({ as_user $P1; echo "select post_match('$CLUB','padel', now()+interval '8 day', now()+interval '8 day 90 min', null, null, 3, 'race', null, 'approval');"; } | $PSQL -At -d $DB | tail -1)
{ as_user $P4; echo "begin; select join_match('$PL'); select pg_sleep(0.6); commit;"; } | $PSQL -q -d $DB >/dev/null 2>&1 &
sleep 0.2
{ as_user $P1; echo "select set_match_status('$PL','closed');"; } | $PSQL -q -d $DB >/dev/null 2>&1
wait
check service "92x a request racing the switch never survives as pending" "select status||'/'||(select count(*) from match_players where match_id='$PL' and status='pending') from matches where id='$PL';" "closed/0"

# --- full is not private (Paul on the phone, 11 Nov): a match closes itself when the last spot goes
FU=$({ as_user $P1; echo "select post_match('$CLUB','padel', now()+interval '10 day', now()+interval '10 day 90 min', null, null, 1, 'one spot', null, 'approval');"; } | $PSQL -At -d $DB | tail -1)
{ as_user $P2; echo "select join_match('$FU');"; } | $PSQL -q -d $DB >/dev/null
check $P1 "93a before the organizer accepts: still open"            "select status||'/'||coalesce(closed_reason,'-') from match_board(null, 30) where match_id='$FU';" "open/-"
check $P1 "93b accepting the last player closes it as full, not private" "select decide_join('$FU','$P2', true); select status||'/'||closed_reason from match_board(null, 30) where match_id='$FU';" "closed/full"
denied $P1 "93c a full match cannot be put back on the board"       "select set_match_status('$FU','open');"
check $P1 "93d adding a spot is how you reopen it"                  "select update_match('$FU', 2, null, null, null, 'approval'); select status||'/'||coalesce(closed_reason,'-') from match_board(null, 30) where match_id='$FU';" "open/-"
check $P1 "93e full again, then made private -> reason changes"      "select update_match('$FU', 1, null, null, null, 'approval'); select set_match_status('$FU','closed'); select status||'/'||closed_reason from match_board(null, 30) where match_id='$FU';" "closed/organizer"
{ as_user $P2; echo "select leave_match('$FU');"; } | $PSQL -q -d $DB >/dev/null
check $P1 "93g still private after he left"                         "select status||'/'||closed_reason from match_board(null, 30) where match_id='$FU';" "closed/organizer"
check $P1 "93h now that there is room again it can go back on the board" "select set_match_status('$FU','open'); select status from match_board(null, 30) where match_id='$FU';" "open"

check  $P2 "91j both messages are still listed (one marked deleted)" "select count(*) from match_messages_list('$PM', null);" 2
check  $P2 "91k remove the finished conversation -> empty for me"  "select hide_match('$PM'); select count(*) from match_messages_list('$PM', null);" 0
check  $P2 "91l removed match is out of my history"                "select count(*) from my_agenda() where id='$PM';" 0
check  $P1 "91m the organizer still sees it"                       "select (select count(*) from match_messages_list('$PM', null))||'/'||(select count(*) from my_agenda() where id='$PM');" "2/1"
check  $P2 "91n undo restores it"                                  "select hide_match('$PM', false); select count(*) from my_agenda() where id='$PM';" 1
FM=$({ as_user $P1; echo "select post_match('$CLUB','padel', now()+interval '9 day', now()+interval '9 day 90 min', null, null, 2, 'future', null, 'open');"; } | $PSQL -At -d $DB | tail -1)
denied $P1 "91o cannot remove a match that has not happened yet"   "select hide_match('$FM');"
# a match under way has started but not ended: it is not finished
OM=$($PSQL -At -q -d $DB -c "insert into matches (club_id, sport, organizer_id, start_at, end_at, players_needed, status) values ('$CLUB','padel','$P1', now() - interval '30 min', now() + interval '60 min', 1, 'open') returning id" | head -1)
denied $P1 "91p cannot remove a match that is under way"           "select hide_match('$OM');"

# deletion must reach the other player's open screen: an incremental read cannot carry it, a full read can
AFTER=$($PSQL -At -q -d $DB -c "select max(created_at) from match_messages where match_id='$PM'" | head -1)
check $P1 "91q incremental read after the last message carries nothing" "select count(*) from match_messages_list('$PM', '$AFTER');" 0
check $P1 "91r full read shows player2's message as deleted"        "select deleted from match_messages_list('$PM', null) where id='$MSG';" "t"

# A mid-suite re-application used to live here, globbing 00[45]*.sql. That glob was written when the
# newest migration was in the 0050s, so it re-created 0056's ten-argument set_club_venue and stopped
# before 0062 could drop it again — the exact hazard the status doc warns about, inside the suite
# itself, silently corrupting every check that followed. Section AL does this properly: all of them,
# in order, at the very end, with the end state asserted afterwards.
check $P1 "91t chat still works after the re-apply"                "select count(*) from match_messages_list('$PM', null);" 2

echo "--- AG. staff calendar (Phase 9a): walk-in entry, suggestions, free now"
SD="(current_date + 12 + time '09:00') at time zone 'Asia/Beirut'"
SD2="(current_date + 12 + time '10:00') at time zone 'Asia/Beirut'"
check $ADMIN "94a admin books a walk-in -> confirmed, desk source, priced, no fee" "select staff_book('$CLUB','$COURT', $SD, $SD2, 'Walk In', '03 111 222') is not null; select status||'/'||source||'/'||price_usd||'/'||fee_usd from bookings where club_id='$CLUB' and guest_name='Walk In';" "confirmed/staff/20.00/0.00"
check service "94b no payment row was created, so nothing reads as collected" "select count(*) from payments p join bookings b on b.id=p.booking_id where b.guest_name='Walk In';" 0
denied $ADMIN "94c the same court and time again -> slot_taken"       "select staff_book('$CLUB','$COURT', $SD, $SD2, 'Second', null);"
denied $P1 "94d a player is not staff"                                "select staff_book('$CLUB','$COURT', (current_date + 12 + time '14:00') at time zone 'Asia/Beirut', (current_date + 12 + time '15:00') at time zone 'Asia/Beirut', 'Nope', null);"
denied $STAFF_B "94e staff of another club cannot book here"          "select staff_book('$CLUB','$COURT', (current_date + 12 + time '14:00') at time zone 'Asia/Beirut', (current_date + 12 + time '15:00') at time zone 'Asia/Beirut', 'Nope', null);"
denied $ADMIN "94f a court from another club is refused"              "select staff_book('$CLUB',(select id from courts where name='Other 1'), (current_date + 12 + time '14:00') at time zone 'Asia/Beirut', (current_date + 12 + time '15:00') at time zone 'Asia/Beirut', 'Nope', null);"
denied $ADMIN "94g no name"                                           "select staff_book('$CLUB','$COURT', (current_date + 12 + time '14:00') at time zone 'Asia/Beirut', (current_date + 12 + time '15:00') at time zone 'Asia/Beirut', '   ', null);"
denied $ADMIN "94h 30 min is below the club minimum"                  "select staff_book('$CLUB','$COURT', (current_date + 12 + time '14:00') at time zone 'Asia/Beirut', (current_date + 12 + time '14:30') at time zone 'Asia/Beirut', 'Short', null);"
denied $ADMIN "94i 4 h is above the club maximum"                     "select staff_book('$CLUB','$COURT', (current_date + 12 + time '14:00') at time zone 'Asia/Beirut', (current_date + 12 + time '18:00') at time zone 'Asia/Beirut', 'Long', null);"
denied $ADMIN "94j a start off the slot grid"                         "select staff_book('$CLUB','$COURT', (current_date + 12 + time '14:07') at time zone 'Asia/Beirut', (current_date + 12 + time '15:07') at time zone 'Asia/Beirut', 'Off grid', null);"
denied $ADMIN "94k before opening time"                               "select staff_book('$CLUB','$COURT', (current_date + 12 + time '06:00') at time zone 'Asia/Beirut', (current_date + 12 + time '07:00') at time zone 'Asia/Beirut', 'Too early', null);"
denied $ADMIN "94l an inactive court"                                 "select staff_book('$CLUB',(select id from courts where club_id='$CLUB' and not active limit 1), $SD, $SD2, 'Inactive', null);"
check $ADMIN "94m suggestions find that customer by part of the name" "select name||'/'||coalesce(phone,'-') from club_recent_guests('$CLUB','Walk I');" "Walk In/03 111 222"
check $ADMIN "94n suggestions are scoped to this club"               "select count(*) from club_recent_guests('$CLUB_B','walk');" 0
denied $P1 "94o a player gets no customer list"                      "select count(*) from club_recent_guests('$CLUB', null);"
check $ADMIN "94o2 a suggestion carries a name and phone only, never a player id" "select count(*) from information_schema.routines r join information_schema.parameters p on p.specific_name=r.specific_name where r.routine_name='club_recent_guests' and p.parameter_mode='TABLE' and p.parameter_name in ('profile_id','player_id');" 0
check $ADMIN "94p common duration is a whole number of slots within the club's range" "select (club_common_duration('$CLUB') % slot_minutes = 0 and club_common_duration('$CLUB') between min_booking_minutes and max_booking_minutes) from clubs where id='$CLUB';" t
check $ADMIN "94q free-now lists every active court once"            "select count(*) = (select count(*) from courts where club_id='$CLUB' and active) from club_courts_free_now('$CLUB');" t
# "busy right now" fixtures have to sit on the club's grid, so open the club round the clock for them.
# Opening hours are not enough on their own: a slot around "now" must also stay inside one local day,
# or the fixture's own insert is refused and the checks below test nothing. So park the club in a
# fixed-offset zone where this moment is the middle of the day. Both this block and the free-now
# checks further down use it.
TZ_MID=$($PSQL -At -q -d $DB -c "select 'Etc/GMT' || case when h > 0 then '+' else '' end || h from (select extract(hour from now() at time zone 'UTC')::int - 12 h) t" | head -1)
$PSQL -q -d $DB -c "update clubs set timezone='$TZ_MID', open_time='00:00', close_time='24:00' where id='$CLUB';" >/dev/null
H="(date_trunc('hour', now()) + case when extract(minute from now()) >= 30 then interval '30 min' else interval '0 min' end)"
$PSQL -q -d $DB -c "insert into bookings (club_id, court_id, guest_name, start_at, end_at, status, source, created_by, price_usd, fee_usd) values ('$CLUB','$COURT2','Now Playing', $H - interval '30 min', $H + interval '30 min', 'confirmed','staff','$ADMIN',30,0);" >/dev/null
$PSQL -q -d $DB -c "insert into blocks (club_id, court_id, start_at, end_at, reason, created_by) values ('$CLUB','$COURT3', $H, $H + interval '30 min', 'maintenance','$ADMIN');" >/dev/null
check $ADMIN "94r the booked court reads busy, and frees when it ends" "select busy||'/'||(free_at > now()) from club_courts_free_now('$CLUB') where court_id='$COURT2';" "true/true"
check $ADMIN "94s a blocked court reads busy too"                     "select busy from club_courts_free_now('$CLUB') where court_id='$COURT3';" "t"
# an expired hold must not keep a court busy
$PSQL -q -d $DB -c "insert into bookings (club_id, court_id, player_id, start_at, end_at, status, source, created_by, hold_expires_at, price_usd, fee_usd) values ('$CLUB','$COURT', '$P1', $H, $H + interval '60 min', 'pending','app','$P1', now() - interval '1 min', 30, 1);" >/dev/null
check $ADMIN "94t an expired hold does not hold a court"              "select busy from club_courts_free_now('$CLUB') where court_id='$COURT';" "f"
denied $P1 "94u a player cannot read the club's free-now list"        "select count(*) from club_courts_free_now('$CLUB');"

# 0047: back-to-back blocks must not report the court free in between
$PSQL -q -d $DB -c "insert into blocks (club_id, court_id, start_at, end_at, reason, created_by) values ('$CLUB','$COURT3', $H + interval '30 min', $H + interval '60 min', 'more maintenance','$ADMIN');" >/dev/null
check $ADMIN "94v free-at follows the chain to the real end"          "select busy||'/'||(free_at = $H + interval '60 min') from club_courts_free_now('$CLUB') where court_id='$COURT3';" "true/true"
COURT4=$($PSQL -At -q -d $DB -c "select id from courts where name='Tennis 2'" | head -1)
check $ADMIN "94w a court with nothing on it has no free-at"          "select busy||'/'||(free_at is null) from club_courts_free_now('$CLUB') where court_id='$COURT4';" "false/true"
$PSQL -q -d $DB -c "update clubs set timezone='Asia/Beirut', open_time='08:00', close_time='23:00' where id='$CLUB';" >/dev/null

# 0047: the desk cannot insert a booking straight into the table any more — staff_book() or nothing
# a perfectly valid slot, so only the missing policy can refuse it
denied $ADMIN "94x a direct insert is refused by RLS, not by a trigger" "insert into bookings (club_id, court_id, guest_name, start_at, end_at, status, source, created_by) values ('$CLUB','$COURT','Sneaky', (current_date + 13 + time '14:00') at time zone 'Asia/Beirut', (current_date + 13 + time '15:00') at time zone 'Asia/Beirut', 'confirmed','staff','$ADMIN');"
check service "94y and nothing got through"                           "select count(*) from bookings where guest_name='Sneaky';" 0
# two different customers who happen to share a name stay two suggestions
$PSQL -q -d $DB -c "insert into bookings (club_id, court_id, guest_name, guest_phone, start_at, end_at, status, source, created_by, price_usd, fee_usd) values ('$CLUB','$COURT','Same Name','03 777 111', (current_date + 13 + time '09:00') at time zone 'Asia/Beirut', (current_date + 13 + time '10:00') at time zone 'Asia/Beirut', 'confirmed','staff','$ADMIN',20,0), ('$CLUB','$COURT','Same Name','03 888 222', (current_date + 13 + time '10:00') at time zone 'Asia/Beirut', (current_date + 13 + time '11:00') at time zone 'Asia/Beirut', 'confirmed','staff','$ADMIN',20,0), ('$CLUB','$COURT','Same Name',null, (current_date + 13 + time '11:00') at time zone 'Asia/Beirut', (current_date + 13 + time '12:00') at time zone 'Asia/Beirut', 'confirmed','staff','$ADMIN',20,0);" >/dev/null
check $ADMIN "94z same name, different phones -> separate suggestions" "select count(*) from club_recent_guests('$CLUB','Same Name');" 3
check $ADMIN "94z2 the one stored without a phone keeps no phone"      "select count(*) from club_recent_guests('$CLUB','Same Name') where phone is null;" 1
# the week view reads a 7-day range for one court straight from the table, so RLS is what scopes it
WK="start_at < (current_date + 20) and end_at > (current_date + 13)"
check $ADMIN "95a staff read the week's rows for one court"           "select count(*) from bookings where club_id='$CLUB' and court_id='$COURT' and $WK;" 4
check $STAFF_B "95b staff of another club read none of them"          "select count(*) from bookings where club_id='$CLUB' and court_id='$COURT' and $WK;" 0
check $P1 "95c a player reads only their own in that range"           "select count(*) from bookings where club_id='$CLUB' and court_id='$COURT' and $WK and player_id is distinct from '$P1';" 0

# 0048: the desk needs a phone number for an app booking too, and only for its own club
$PSQL -q -d $DB -c "update profiles set phone='03 555 999' where id='$P1';" >/dev/null
APPB=$($PSQL -At -q -d $DB -c "select id from bookings where player_id='$P1' and club_id='$CLUB' and status='confirmed' limit 1" | head -1)
check $ADMIN "96a staff get the player's own phone for an app booking" "select name||'/'||phone from club_booking_contacts('$CLUB', array['$APPB']::uuid[]);" "Player One/03 555 999"
check $ADMIN "96b a desk booking keeps its guest name and phone"       "select name||'/'||phone from club_booking_contacts('$CLUB', (select array_agg(id) from bookings where guest_name='Walk In'));" "Walk In/03 111 222"
denied $P1 "96c a player cannot look up contacts"                      "select count(*) from club_booking_contacts('$CLUB', array['$APPB']::uuid[]);"
denied $STAFF_B "96d staff of another club cannot either"              "select count(*) from club_booking_contacts('$CLUB', array['$APPB']::uuid[]);"
check $STAFF_B "96e and asking under their own club returns nothing"   "select count(*) from club_booking_contacts('$CLUB_B', array['$APPB']::uuid[]);" 0

# 0049: a hold only occupies its slot until the hold runs out
# These checks book slots that contain "now", so the slot must not straddle the club's local midnight
# — near midnight in Beirut the fixture's own inserts would be refused and the checks would pass or
# fail by the hour. Park the club in a fixed-offset zone where this moment is the middle of the day.
$PSQL -q -d $DB -c "update clubs set timezone='$TZ_MID', open_time='00:00', close_time='24:00' where id='$CLUB';" >/dev/null
H2="(date_trunc('hour', now()) + case when extract(minute from now()) >= 30 then interval '30 min' else interval '0 min' end)"
# the reviewer's case: a block ending soon, then a held slot whose hold dies before that slot starts
$PSQL -q -d $DB -c "delete from blocks where club_id='$CLUB' and court_id='$COURT4'; delete from bookings where club_id='$CLUB' and court_id='$COURT4';" >/dev/null
$PSQL -q -d $DB -c "insert into blocks (club_id, court_id, start_at, end_at, reason, created_by) values ('$CLUB','$COURT4', $H2 - interval '30 min', $H2 + interval '30 min', 'ends soon','$ADMIN');" >/dev/null
$PSQL -q -d $DB -c "insert into bookings (club_id, court_id, player_id, start_at, end_at, status, source, created_by, hold_expires_at, price_usd, fee_usd) values ('$CLUB','$COURT4','$P4', $H2 + interval '30 min', $H2 + interval '90 min', 'pending','app','$P2', now() + interval '5 min', 30, 1);" >/dev/null
# the dead hold must not drag free_at out to its slot's end; whichever of the block or the hold dies last wins
check $ADMIN "97a a hold that dies before its slot starts does not extend the chain" "select busy||'/'||(free_at <= greatest($H2 + interval '30 min', now() + interval '5 min')) from club_courts_free_now('$CLUB') where court_id='$COURT4';" "true/true"
# a hold that runs out part-way through its own slot frees the court at that moment, not at the slot's end
$PSQL -q -d $DB -c "delete from blocks where club_id='$CLUB' and court_id='$COURT4'; delete from bookings where club_id='$CLUB' and court_id='$COURT4';" >/dev/null
$PSQL -q -d $DB -c "insert into bookings (club_id, court_id, player_id, start_at, end_at, status, source, created_by, hold_expires_at, price_usd, fee_usd) values ('$CLUB','$COURT4','$P4', $H2, $H2 + interval '60 min', 'pending','app','$P2', now() + interval '4 min', 30, 1);" >/dev/null
check $ADMIN "97b a hold expiring mid-slot frees the court when it expires, not at the slot's end" "select busy||'/'||(free_at <= now() + interval '5 min') from club_courts_free_now('$CLUB') where court_id='$COURT4';" "true/true"
# and a hold already dead holds nothing at all
$PSQL -q -d $DB -c "update bookings set hold_expires_at = now() - interval '1 min' where club_id='$CLUB' and court_id='$COURT4' and status='pending';" >/dev/null
check $ADMIN "97c an expired hold leaves the court free"              "select busy||'/'||(free_at is null) from club_courts_free_now('$CLUB') where court_id='$COURT4';" "false/true"
# a paid booking behind the dead hold still occupies the court
$PSQL -q -d $DB -c "delete from bookings where club_id='$CLUB' and court_id='$COURT4';" >/dev/null
$PSQL -q -d $DB -c "insert into bookings (club_id, court_id, guest_name, start_at, end_at, status, source, created_by, price_usd, fee_usd) values ('$CLUB','$COURT4','Confirmed', $H2, $H2 + interval '60 min', 'confirmed','staff','$ADMIN',30,0);" >/dev/null
check $ADMIN "97d a confirmed booking is unaffected by the hold rule"  "select busy||'/'||(free_at = $H2 + interval '60 min') from club_courts_free_now('$CLUB') where court_id='$COURT4';" "true/true"
$PSQL -q -d $DB -c "update clubs set timezone='Asia/Beirut', open_time='08:00', close_time='23:00' where id='$CLUB';" >/dev/null

# moving a booking must land on the day it is given, not on whatever day the calendar happens to show
$PSQL -q -d $DB -c "delete from bookings where club_id='$CLUB' and court_id='$COURT4';" >/dev/null
MV=$($PSQL -At -q -d $DB -c "insert into bookings (club_id, court_id, guest_name, start_at, end_at, status, source, created_by, price_usd, fee_usd) values ('$CLUB','$COURT4','Mover', (current_date + 16 + time '09:00') at time zone 'Asia/Beirut', (current_date + 16 + time '10:00') at time zone 'Asia/Beirut', 'confirmed','staff','$ADMIN',20,0) returning id" | head -1)
check $ADMIN "98a a move lands on the day it was given, three days later" "select move_booking('$MV','$COURT4', (current_date + 19 + time '14:00') at time zone 'Asia/Beirut', (current_date + 19 + time '15:00') at time zone 'Asia/Beirut'); select ((start_at at time zone 'Asia/Beirut')::date - current_date)||'/'||to_char(start_at at time zone 'Asia/Beirut','HH24:MI') from bookings where id='$MV';" "19/14:00"

echo "--- AH. how many players a match is looking for (1-30)"
mk () { { as_user $P1; echo "select post_match('$CLUB','football', now()+interval '$2 day', now()+interval '$2 day 90 min', null, null, $1, 'squad', null, 'open');"; } | $PSQL -At -d $DB | tail -1; }
for n in 6 10 18 24; do
  M=$(mk $n 21)
  check $P1 "99-$n a match can ask for $n players"                  "select players_needed from match_board(null, 30) where match_id='$M';" $n
  { as_user $P1; echo "select set_match_status('$M','cancelled');"; } | $PSQL -q -d $DB >/dev/null
done
B30=$(mk 30 22)
check $P1 "99a the upper boundary, 30, is allowed"                  "select players_needed from match_board(null, 30) where match_id='$B30';" 30
denied $P1 "99b 31 is refused"                                      "select post_match('$CLUB','football', now()+interval '23 day', now()+interval '23 day 90 min', null, null, 31, 'too many', null, 'open');"
denied $P1 "99c 0 is refused"                                       "select post_match('$CLUB','football', now()+interval '23 day', now()+interval '23 day 90 min', null, null, 0, 'none', null, 'open');"
denied $P1 "99d a negative number is refused"                       "select post_match('$CLUB','football', now()+interval '23 day', now()+interval '23 day 90 min', null, null, -3, 'negative', null, 'open');"
denied $P1 "99e no number at all is refused"                        "select post_match('$CLUB','football', now()+interval '23 day', now()+interval '23 day 90 min', null, null, null, 'null', null, 'open');"
denied service "99f the table refuses 31 even behind the functions" "insert into matches (club_id, sport, organizer_id, start_at, end_at, players_needed, status) values ('$CLUB','football','$P1', now()+interval '23 day', now()+interval '23 day 90 min', 31, 'open');"

# editing: up to 30, down to the number already accepted but no further
ED=$(mk 6 24)
check $P1 "99g edit 6 -> 24"                                        "select update_match('$ED', 24, null, null, 'bigger', 'open'); select players_needed from match_board(null, 30) where match_id='$ED';" 24
check $P1 "99h edit 24 -> 30"                                       "select update_match('$ED', 30, null, null, 'bigger', 'open'); select players_needed from match_board(null, 30) where match_id='$ED';" 30
denied $P1 "99i edit above 30 is refused"                           "select update_match('$ED', 31, null, null, 'nope', 'open');"
{ as_user $P2; echo "select join_match('$ED');"; } | $PSQL -q -d $DB >/dev/null
{ as_user $P3; echo "select join_match('$ED');"; } | $PSQL -q -d $DB >/dev/null
check $P1 "99j two joined, so it can be cut to 2"                   "select update_match('$ED', 2, null, null, 'smaller', 'open'); select status||'/'||closed_reason from match_board(null, 30) where match_id='$ED';" "closed/full"
denied $P1 "99k but not to 1, below the players already in"         "select update_match('$ED', 1, null, null, 'too small', 'open');"
check $P1 "99l raising it again reopens the match"                  "select update_match('$ED', 5, null, null, 'room again', 'open'); select status||'/'||(5 - joined) from match_board(null, 30) where match_id='$ED';" "open/3"

# the last spot, wanted by two people at once: the database decides, not the screen
LS=$(mk 24 25)
$PSQL -q -d $DB -c "insert into match_players (match_id, profile_id, status) select '$LS', id, 'accepted' from profiles where id in ('$P2','$P3');" >/dev/null
{ as_user $P1; echo "select update_match('$LS', 3, null, null, 'one left', 'open');"; } | $PSQL -q -d $DB >/dev/null
{ as_user $P4; echo "begin; select pg_sleep(0.1); select join_match('$LS'); commit;"; } | $PSQL -q -d $DB >/dev/null 2>&1 &
{ as_user $ADMIN; echo "begin; select pg_sleep(0.1); select join_match('$LS'); commit;"; } | $PSQL -q -d $DB >/dev/null 2>&1 &
wait
check service "99m only one of the two got the last spot"           "select count(*) from match_players where match_id='$LS' and status='accepted';" 3
check service "99n and the match closed itself as full"             "select status||'/'||closed_reason from matches where id='$LS';" "closed/full"

echo "--- AI. pay at the desk (Phase 10)"
CB=$($PSQL -At -q -d $DB -c "select id from clubs where slug='batroun'" | head -1)
check service "100a existing clubs keep paying in the app"          "select payment_mode from clubs where id='$CB';" "simulated"
denied $P4 "100b book_at_desk is refused while the club pays in-app" "select book_at_desk('$COURT', (current_date + 9 + time '09:00') at time zone 'Asia/Beirut', (current_date + 9 + time '10:00') at time zone 'Asia/Beirut', gen_random_uuid());"
denied $P4 "100c a player cannot switch a club's mode"              "select set_club_payment_mode('$CB','at_desk');"

# a hold in flight when the club switches must not survive as something payable
HB=$({ as_user $P2; echo "select booking_id from hold_slot('$CB','$COURT', (current_date + 9 + time '11:00') at time zone 'Asia/Beirut', (current_date + 9 + time '12:00') at time zone 'Asia/Beirut');"; } | $PSQL -At -d $DB | tail -1)
check service "100d the hold exists before the switch"              "select status from bookings where id='$HB';" "pending"
check $ADMIN "100e switching to at-the-desk releases it"            "select set_club_payment_mode('$CB','at_desk');" 1
check service "100f the booking is expired, not left hanging"       "select status from bookings where id='$HB';" "expired"
check service "100g and so is its payment"                          "select status from payments where booking_id='$HB';" "expired"

# the in-app flow is now refused at every entry point
denied $P4 "100h hold_slot is refused"                              "select hold_slot('$CB','$COURT', (current_date + 9 + time '13:00') at time zone 'Asia/Beirut', (current_date + 9 + time '14:00') at time zone 'Asia/Beirut');"
denied service "100i a payment row cannot even be created"          "insert into payments (booking_id, profile_id, club_id, provider, amount_usd, fee_usd, total_usd) values ('$HB','$P2','$CB','simulated',20,1,21);"
denied service "100j and an old one cannot be marked paid"          "update payments set status='paid' where booking_id='$HB';"

# reserving at the desk
$PSQL -q -d $DB -c "update clubs set max_upcoming_bookings = 3 where id='$CB';" >/dev/null
TK=$($PSQL -At -q -d $DB -c "select gen_random_uuid()" | head -1)
AD=$({ as_user $P4; echo "select booking_id from book_at_desk('$COURT', (current_date + 9 + time '15:00') at time zone 'Asia/Beirut', (current_date + 9 + time '16:00') at time zone 'Asia/Beirut', '$TK');"; } | $PSQL -At -d $DB | tail -1)
check service "100k confirmed at once, priced, no CourtBook fee"    "select status||'/'||price_usd||'/'||fee_usd||'/'||source from bookings where id='$AD';" "confirmed/20.00/0.00/app"
check service "100l and no payment row exists for it"               "select count(*) from payments where booking_id='$AD';" 0
check $P4 "100m the same token returns the same booking, not a second" "select booking_id='$AD' from book_at_desk('$COURT', (current_date + 9 + time '15:00') at time zone 'Asia/Beirut', (current_date + 9 + time '16:00') at time zone 'Asia/Beirut', '$TK');" "t"
check service "100n so the player still has exactly one"            "select count(*) from bookings where player_id='$P4' and club_id='$CB' and start_at > now() and status='confirmed' and client_token='$TK';" 1
denied $P2 "100o someone else cannot take the same slot"            "select book_at_desk('$COURT', (current_date + 9 + time '15:00') at time zone 'Asia/Beirut', (current_date + 9 + time '16:00') at time zone 'Asia/Beirut', gen_random_uuid());"

# the cap on how many a player may hold at once
$PSQL -q -d $DB -c "update clubs set max_upcoming_bookings = 3 where id='$CB';" >/dev/null
{ as_user $P4; echo "select book_at_desk('$COURT', (current_date + 10 + time '15:00') at time zone 'Asia/Beirut', (current_date + 10 + time '16:00') at time zone 'Asia/Beirut', gen_random_uuid());"; } | $PSQL -q -d $DB >/dev/null
{ as_user $P4; echo "select book_at_desk('$COURT', (current_date + 11 + time '15:00') at time zone 'Asia/Beirut', (current_date + 11 + time '16:00') at time zone 'Asia/Beirut', gen_random_uuid());"; } | $PSQL -q -d $DB >/dev/null
check service "100p three ahead of them now"                        "select count(*) from bookings where player_id='$P4' and club_id='$CB' and status='confirmed' and start_at > now();" 3
denied $P4 "100q a fourth is refused"                               "select book_at_desk('$COURT', (current_date + 13 + time '15:00') at time zone 'Asia/Beirut', (current_date + 13 + time '16:00') at time zone 'Asia/Beirut', gen_random_uuid());"
{ as_user $P4; echo "select cancel_booking('$AD', false);"; } | $PSQL -q -d $DB >/dev/null
check $P4 "100r cancelling one frees a place"                       "select count(*) from book_at_desk('$COURT', (current_date + 13 + time '15:00') at time zone 'Asia/Beirut', (current_date + 13 + time '16:00') at time zone 'Asia/Beirut', gen_random_uuid());" 1
check service "100s a booking already under way does not count"     "select count(*) from bookings where player_id='$P4' and club_id='$CB' and status='confirmed' and start_at > now();" 3
# two devices, one player, same slot, different tokens: the court decides
{ as_user $P2; echo "begin; select pg_sleep(0.1); select book_at_desk('$COURT', (current_date + 12 + time '15:00') at time zone 'Asia/Beirut', (current_date + 12 + time '16:00') at time zone 'Asia/Beirut', gen_random_uuid()); commit;"; } | $PSQL -q -d $DB >/dev/null 2>&1 &
{ as_user $P3; echo "begin; select pg_sleep(0.1); select book_at_desk('$COURT', (current_date + 12 + time '15:00') at time zone 'Asia/Beirut', (current_date + 12 + time '16:00') at time zone 'Asia/Beirut', gen_random_uuid()); commit;"; } | $PSQL -q -d $DB >/dev/null 2>&1 &
wait
check service "100t only one reservation exists for that slot"      "select count(*) from bookings where court_id='$COURT' and start_at = (current_date + 12 + time '15:00') at time zone 'Asia/Beirut' and status='confirmed';" 1
$PSQL -q -d $DB -c "select set_config('request.jwt.claim.sub','$ADMIN',false); select set_club_payment_mode('$CB','simulated');" >/dev/null 2>&1
$PSQL -q -d $DB -c "update clubs set payment_mode='simulated' where id='$CB';" >/dev/null

# 0052: a token is a retry of one request, not a licence to reuse
$PSQL -q -d $DB -c "update clubs set payment_mode='at_desk', max_upcoming_bookings=10 where id='$CB';" >/dev/null
TK2=$($PSQL -At -q -d $DB -c "select gen_random_uuid()" | head -1)
{ as_user $P4; echo "select book_at_desk('$COURT', (current_date + 10 + time '09:00') at time zone 'Asia/Beirut', (current_date + 10 + time '10:00') at time zone 'Asia/Beirut', '$TK2');"; } | $PSQL -q -d $DB >/dev/null
denied $P4 "100u the same token with a different day is refused"     "select book_at_desk('$COURT', (current_date + 11 + time '09:00') at time zone 'Asia/Beirut', (current_date + 11 + time '10:00') at time zone 'Asia/Beirut', '$TK2');"
denied $P4 "100v the same token with a different court is refused"   "select book_at_desk('$COURT2', (current_date + 10 + time '09:00') at time zone 'Asia/Beirut', (current_date + 10 + time '10:00') at time zone 'Asia/Beirut', '$TK2');"
denied $P4 "100w the same token with a different length is refused"  "select book_at_desk('$COURT', (current_date + 10 + time '09:00') at time zone 'Asia/Beirut', (current_date + 10 + time '10:30') at time zone 'Asia/Beirut', '$TK2');"
check service "100x and no second booking was made"                  "select count(*) from bookings where client_token='$TK2';" 1

# 0052: a late confirmation must not invent money owed by a club that never took any
$PSQL -q -d $DB -c "update clubs set payment_mode='simulated' where id='$CB';" >/dev/null
LP=$({ as_user $P2; echo "select payment_id from hold_slot('$CB','$COURT3', (current_date + 10 + time '19:00') at time zone 'Asia/Beirut', (current_date + 10 + time '20:00') at time zone 'Asia/Beirut');"; } | $PSQL -At -d $DB | tail -1)
{ as_user $ADMIN; echo "select set_club_payment_mode('$CB','at_desk');"; } | $PSQL -q -d $DB >/dev/null
denied service "100y a stale confirm cannot create a refund"         "select confirm_payment('$LP','stale-ref', (select total_usd from payments where id='$LP'));"
check service "100z the payment is still expired, owing nothing"     "select status from payments where id='$LP';" "expired"
# but money actually taken can still be refunded after the switch
$PSQL -q -d $DB -c "update clubs set payment_mode='simulated' where id='$CB';" >/dev/null
PP=$({ as_user $P3; echo "select payment_id from hold_slot('$CB','$COURT3', (current_date + 11 + time '19:00') at time zone 'Asia/Beirut', (current_date + 11 + time '20:00') at time zone 'Asia/Beirut');"; } | $PSQL -At -d $DB | tail -1)
$PSQL -q -d $DB -c "update payments set provider='whish' where id='$PP'; select confirm_payment('$PP','real-ref', (select total_usd from payments where id='$PP'));" >/dev/null
{ as_user $ADMIN; echo "select set_club_payment_mode('$CB','at_desk');"; } | $PSQL -q -d $DB >/dev/null
check service "101a a payment taken before the switch can be refunded" "update payments set status='refund_due' where id='$PP'; select status from payments where id='$PP';" "refund_due"

# 0052: a mode switch and a reservation cannot interleave
$PSQL -q -d $DB -c "update clubs set payment_mode='at_desk' where id='$CB';" >/dev/null
{ as_user $ADMIN; echo "begin; select set_club_payment_mode('$CB','simulated'); select pg_sleep(1.5); commit;"; } | $PSQL -q -d $DB >/dev/null 2>&1 &
sleep 0.8
{ as_user $P4; echo "select book_at_desk('$COURT', (current_date + 9 + time '21:00') at time zone 'Asia/Beirut', (current_date + 9 + time '22:00') at time zone 'Asia/Beirut', gen_random_uuid());"; } | $PSQL -q -d $DB >/dev/null 2>&1
wait
check service "101b a reservation racing a switch to in-app never lands" "select count(*) from bookings where court_id='$COURT' and start_at = (current_date + 9 + time '21:00') at time zone 'Asia/Beirut' and status='confirmed';" 0
# and the reverse: a hold racing a switch to at-the-desk
$PSQL -q -d $DB -c "update clubs set payment_mode='simulated' where id='$CB';" >/dev/null
{ as_user $ADMIN; echo "begin; select set_club_payment_mode('$CB','at_desk'); select pg_sleep(1.5); commit;"; } | $PSQL -q -d $DB >/dev/null 2>&1 &
sleep 0.8
{ as_user $P2; echo "select hold_slot('$CB','$COURT3', (current_date + 12 + time '19:00') at time zone 'Asia/Beirut', (current_date + 12 + time '20:00') at time zone 'Asia/Beirut');"; } | $PSQL -q -d $DB >/dev/null 2>&1
wait
check service "101c a hold racing a switch to at-the-desk leaves no payment" "select count(*) from payments p join bookings b on b.id=p.booking_id where b.court_id='$COURT3' and b.start_at = (current_date + 12 + time '19:00') at time zone 'Asia/Beirut' and p.status in ('pending','paid');" 0
$PSQL -q -d $DB -c "update clubs set payment_mode='simulated' where id='$CB';" >/dev/null

# 0053: a refund must be able to finish, not just start
$PSQL -q -d $DB -c "update clubs set payment_mode='simulated' where id='$CB';" >/dev/null
FP=$({ as_user $P2; echo "select payment_id from hold_slot('$CB','$COURT3', (current_date + 13 + time '19:00') at time zone 'Asia/Beirut', (current_date + 13 + time '20:00') at time zone 'Asia/Beirut');"; } | $PSQL -At -d $DB | tail -1)
$PSQL -q -d $DB -c "update payments set provider='whish' where id='$FP'; select confirm_payment('$FP','lifecycle-ref', (select total_usd from payments where id='$FP'));" >/dev/null
{ as_user $ADMIN; echo "select set_club_payment_mode('$CB','at_desk');"; } | $PSQL -q -d $DB >/dev/null
check service "101d paid -> refund_due after the switch"             "update payments set status='refund_due' where id='$FP'; select status from payments where id='$FP';" "refund_due"
check service "101e refund_due -> refunded completes the refund"     "update payments set status='refunded' where id='$FP'; select status from payments where id='$FP';" "refunded"
denied service "101f but a never-paid row still cannot be made to owe money" "update payments set status='refund_due' where id='$LP';"

# 0053: a confirmation racing a mode switch must not deadlock, and must not take money
$PSQL -q -d $DB -c "update clubs set payment_mode='simulated' where id='$CB';" >/dev/null
RP=$({ as_user $P3; echo "select payment_id from hold_slot('$CB','$COURT2', (current_date + 13 + time '19:00') at time zone 'Asia/Beirut', (current_date + 13 + time '20:00') at time zone 'Asia/Beirut');"; } | $PSQL -At -d $DB | tail -1)
{ as_user $ADMIN; echo "begin; select set_club_payment_mode('$CB','at_desk'); select pg_sleep(1.5); commit;"; } | $PSQL -q -d $DB >/dev/null 2>&1 &
sleep 0.8
$PSQL -q -d $DB -c "select confirm_payment('$RP','race-ref', (select total_usd from payments where id='$RP'));" >/dev/null 2>&1
wait
check service "101g a confirmation racing the switch takes no money"  "select status from payments where id='$RP';" "expired"
check service "101h and no deadlock left the club half-switched"      "select payment_mode from clubs where id='$CB';" "at_desk"

# 0053: a missing time is not a time
TK3=$($PSQL -At -q -d $DB -c "select gen_random_uuid()" | head -1)
{ as_user $P4; echo "select book_at_desk('$COURT', (current_date + 13 + time '16:00') at time zone 'Asia/Beirut', (current_date + 13 + time '17:00') at time zone 'Asia/Beirut', '$TK3');"; } | $PSQL -q -d $DB >/dev/null
denied $P4 "101i the same token with no start time is refused"        "select book_at_desk('$COURT', null, (current_date + 13 + time '17:00') at time zone 'Asia/Beirut', '$TK3');"
denied $P4 "101j the same token with no end time is refused"          "select book_at_desk('$COURT', (current_date + 13 + time '16:00') at time zone 'Asia/Beirut', null, '$TK3');"
check service "101k still just the one booking for that token"        "select count(*) from bookings where client_token='$TK3';" 1
$PSQL -q -d $DB -c "update clubs set payment_mode='simulated' where id='$CB';" >/dev/null

# 0054: a late payment is money that really arrived, so its refund must be able to finish
$PSQL -q -d $DB -c "update clubs set payment_mode='simulated' where id='$CB';" >/dev/null
LT=$({ as_user $P2; echo "select payment_id from hold_slot('$CB','$COURT4', (current_date + 13 + time '19:00') at time zone 'Asia/Beirut', (current_date + 13 + time '20:00') at time zone 'Asia/Beirut');"; } | $PSQL -At -d $DB | tail -1)
# the hold runs out before the gateway answers
$PSQL -q -d $DB -c "update payments set provider='whish' where id='$LT'; update bookings set hold_expires_at = now() - interval '1 min' where id = (select booking_id from payments where id='$LT'); select expire_stale_holds('$COURT4');" >/dev/null
check service "102a a late receipt is recorded as owed back"          "select confirm_payment('$LT','late-ref', (select total_usd from payments where id='$LT'));" "refund_due"
check service "102b and it carries evidence that money was collected" "select paid_at is not null from payments where id='$LT';" "t"
check service "102c it is not counted as revenue"                     "select status from payments where id='$LT';" "refund_due"
{ as_user $ADMIN; echo "select set_club_payment_mode('$CB','at_desk');"; } | $PSQL -q -d $DB >/dev/null
check service "102d the refund can still be completed after the switch" "update payments set status='refunded', refunded_at=now() where id='$LT'; select status from payments where id='$LT';" "refunded"
# and the thing this rule exists to stop is still stopped
denied service "102e a confirmation with no money behind it is still refused" "select confirm_payment('$LP','another-stale-ref', (select total_usd from payments where id='$LP'));"
$PSQL -q -d $DB -c "update clubs set payment_mode='simulated' where id='$CB';" >/dev/null

# 0054: a real gateway's late receipt still lands at a desk-mode club, because the money did move
$PSQL -q -d $DB -c "update clubs set payment_mode='simulated' where id='$CB';" >/dev/null
GW=$({ as_user $P3; echo "select payment_id from hold_slot('$CB','$COURT4', (current_date + 12 + time '08:00') at time zone 'Asia/Beirut', (current_date + 12 + time '09:00') at time zone 'Asia/Beirut');"; } | $PSQL -At -d $DB | tail -1)
$PSQL -q -d $DB -c "update payments set provider='whish' where id='$GW'; update bookings set hold_expires_at = now() - interval '1 min' where id = (select booking_id from payments where id='$GW'); select expire_stale_holds('$COURT4');" >/dev/null
{ as_user $ADMIN; echo "select set_club_payment_mode('$CB','at_desk');"; } | $PSQL -q -d $DB >/dev/null
check service "102f a real gateway receipt is recorded even after the switch" "select confirm_payment('$GW','whish-late-ref', (select total_usd from payments where id='$GW'));" "refund_due"
check service "102g and that refund can be completed"                 "update payments set status='refunded', refunded_at=now() where id='$GW'; select status from payments where id='$GW';" "refunded"
$PSQL -q -d $DB -c "update clubs set payment_mode='simulated' where id='$CB';" >/dev/null

# 0055: recovering old refund rows without inventing either the money or the moment
$PSQL -q -d $DB -c "update clubs set payment_mode='simulated' where id='$CB';" >/dev/null
R1=$({ as_user $P2; echo "select payment_id from hold_slot('$CB','$COURT4', (current_date + 11 + time '08:00') at time zone 'Asia/Beirut', (current_date + 11 + time '09:00') at time zone 'Asia/Beirut');"; } | $PSQL -At -d $DB | tail -1)
R2=$({ as_user $P3; echo "select payment_id from hold_slot('$CB','$COURT4', (current_date + 11 + time '10:00') at time zone 'Asia/Beirut', (current_date + 11 + time '11:00') at time zone 'Asia/Beirut');"; } | $PSQL -At -d $DB | tail -1)
# two legacy rows as the old code left them: owed back, no paid_at, one real gateway and one simulated
$PSQL -q -d $DB -c "update payments set status='refund_due', provider='whish', provider_ref='legacy-whish', paid_at=null, collected=false where id='$R1'; update payments set status='refund_due', provider='simulated', provider_ref='legacy-sim', paid_at=null, collected=false where id='$R2';" >/dev/null
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -f supabase/migrations/0055_collection_evidence.sql >/dev/null 2>&1
check service "103a a real gateway row is recovered as collected"     "select collected from payments where id='$R1';" "t"
check service "103b without claiming a time it does not know"         "select paid_at is null from payments where id='$R1';" "t"
check service "103c a simulated row is not treated as money"          "select collected from payments where id='$R2';" "f"
{ as_user $ADMIN; echo "select set_club_payment_mode('$CB','at_desk');"; } | $PSQL -q -d $DB >/dev/null
check service "103d the real one can still be refunded in desk mode"  "update payments set status='refunded', refunded_at=now() where id='$R1'; select status from payments where id='$R1';" "refunded"
denied service "103e the simulated one cannot"                        "update payments set status='refunded' where id='$R2';"
$PSQL -q -d $DB -c "update clubs set payment_mode='simulated' where id='$CB';" >/dev/null

echo "--- AJ. club images (Phase 11a)"
# 0036 stopped new functions being executable by default, so every RPC a browser calls needs an
# explicit grant. 0056 forgot one — assert_club_editor, the check the upload route runs before doing
# anything — and the route reported it as the person not being staff. This check lists every RPC the
# app calls that a signed-in user CANNOT execute, and that list must be exactly the ones meant to be
# reachable only by the server. It fails in both directions: a missing grant appears here, and so
# does a server-only function handed to everybody. Add to the list when a new RPC is server-only.
check service "104! only the server-only RPCs are out of a signed-in user's reach" "
  select coalesce(string_agg(p.proname, ',' order by p.proname), '(none)')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
    and p.proname in (
      'add_club_gallery','add_club_staff','add_town','areas','assert_club_editor','book_at_desk',
      'booking_match','cancel_booking','claim_notifications_to_email','claim_payment_session',
      'clear_notifications','close_club','club_balances','club_booking_contacts','club_coach_requests',
      'club_common_duration','club_courts_free_now','club_day_slots','club_discovery','club_recent_guests',
      'club_sports','club_staff_list','coach_availability','coach_card','coaches_at_club','coaches_directory',
      'confirm_payment','decide_coach_club','delete_match_message','delete_notification','hide_match',
      'hold_slot','mark_no_show','mark_notifications_emailed','mark_notifications_read','mark_refunded',
      'match_board','match_is_hidden','match_messages_list','match_participants','move_booking',
      'my_active_hold','my_agenda','my_levels','open_matches','payments_list','payments_summary','post_match',
      'quote_price','record_media_orphan','refunds_due','release_hold','release_payment_session_claim',
      'remove_club_media','remove_club_staff','reorder_club_gallery','set_club_image','set_club_payment_mode',
      'set_gallery_caption','set_match_status','set_player_level','staff_book','update_club_settings');" \
  "add_club_gallery,claim_notifications_to_email,claim_payment_session,confirm_payment,mark_notifications_emailed,record_media_orphan,release_payment_session_claim,remove_club_media,reorder_club_gallery,set_club_image,set_gallery_caption"
# and the check itself, from each kind of caller
# `select void_fn() is null` is false, and a void call in an unreferenced subquery is optimised away
# entirely — both would pass without testing anything. Concatenating the result forces the call.
check $ADMIN   "104@a an admin passes the editor check"               "select 'passed' || coalesce((select assert_club_editor('$CLUB'))::text, '');" "passed"
check $STAFF_B "104@b staff pass it for their own club"               "select 'passed' || coalesce((select assert_club_editor('$CLUB_B'))::text, '');" "passed"
denied $STAFF_B "104@c but not for someone else's"                    "select assert_club_editor('$CLUB');"
denied $P1     "104@d a player is refused"                            "select assert_club_editor('$CLUB');"
denied anon    "104@e and a stranger cannot even run it"              "select assert_club_editor('$CLUB');"
# Publishing an image is a server-only operation. The upload route signs in the person, processes the
# file and then asks the database to publish it, naming who asked. The database still decides whether
# that person may touch the club, and whether the path is one the route could have produced.
mpath() { printf 'clubs/%s/%08d-0000-4000-8000-000000000000.webp' "$1" "$2"; }
MP1=$(mpath $CLUB 1); MP3=$(mpath $CLUB 3)
check service "104a a club with no cover_url gets no media row"       "select count(*) from club_media where club_id='$CLUB';" 0
check service "104b the server may publish a cover for club staff"    "select media_id is not null from set_club_image('$ADMIN','$CLUB','cover','$MP1',1600,600,null);" "t"
check service "104c cover_url is absolute, not relative to the app"   "select cover_url like 'https://%/storage/v1/object/public/club-media/clubs/%' from clubs where id='$CLUB';" "t"
denied $ADMIN  "104d staff cannot publish straight from the browser"  "select set_club_image('$ADMIN','$CLUB','cover','$MP3',1600,600,null);"
denied $P1     "104e nor can a player"                                "select set_club_image('$P1','$CLUB','cover','$MP3',1600,600,null);"
denied anon    "104f nor can a stranger"                              "select set_club_image('$ADMIN','$CLUB','cover','$MP3',1600,600,null);"
denied service "104g the server cannot publish for other club's staff" "select set_club_image('$STAFF_B','$CLUB','cover','$MP3',1600,600,null);"
denied service "104h nor on behalf of a player"                       "select set_club_image('$P1','$CLUB','cover','$MP3',1600,600,null);"
denied service "104i nor for nobody at all"                           "select set_club_image(null,'$CLUB','cover','$MP3',1600,600,null);"
denied service "104j a path belonging to another club is refused"     "select set_club_image('$ADMIN','$CLUB','cover','$(mpath $CLUB_B 9)',1600,600,null);"
denied service "104k a file the route never produced is refused"      "select set_club_image('$ADMIN','$CLUB','cover','clubs/$CLUB/evil.php',1600,600,null);"
denied service "104l a path climbing out of the folder is refused"    "select set_club_image('$ADMIN','$CLUB','cover','clubs/$CLUB/../x.webp',1600,600,null);"
denied service "104m replacing without naming the current image"      "select set_club_image('$ADMIN','$CLUB','cover','$MP3',1600,600,null);"
COV=$($PSQL -At -q -d $DB -c "select id from club_media where club_id='$CLUB' and kind='cover'" | head -1)
check service "104n replacing it, naming it, returns the old file"    "select old_path from set_club_image('$ADMIN','$CLUB','cover','$MP3',1600,600,'$COV');" "$MP1"
check service "104o and only one cover exists"                        "select count(*) from club_media where club_id='$CLUB' and kind='cover';" 1
# the gallery cap holds even when two uploads land together
for i in 11 12 13 14 15 16; do { as_service; echo "select add_club_gallery('$ADMIN','$CLUB','$(mpath $CLUB $i)','shot $i',1200,900);"; } | $PSQL -q -d $DB >/dev/null; done
check service "104p six photos"                                       "select count(*) from club_media where club_id='$CLUB' and kind='gallery';" 6
denied service "104q a seventh is refused"                            "select add_club_gallery('$ADMIN','$CLUB','$(mpath $CLUB 17)',null,1200,900);"
# Two requests racing for the LAST place. With six already there both would be refused whatever the
# locking did, which tested nothing — so go back to five, and give each a path of its own. The first
# transaction holds the club row while it works; the second must wait, then find the gallery full.
{ as_service; echo "select remove_club_media('$ADMIN',(select id from club_media where club_id='$CLUB' and kind='gallery' order by sort desc limit 1));"; } | $PSQL -q -d $DB >/dev/null
check service "104r five photos, one place left"                      "select count(*) from club_media where club_id='$CLUB' and kind='gallery';" 5
{ as_service; echo "begin; select add_club_gallery('$ADMIN','$CLUB','$(mpath $CLUB 18)',null,1200,900); select pg_sleep(1.5); commit;"; } | $PSQL -d $DB > /tmp/cb_gal1.log 2>&1 &
sleep 0.5
{ as_service; echo "select add_club_gallery('$ADMIN','$CLUB','$(mpath $CLUB 19)',null,1200,900);"; } | $PSQL -d $DB > /tmp/cb_gal2.log 2>&1 &
wait
if grep -q ERROR /tmp/cb_gal1.log; then claim "104ra the first of the two takes the last place" 1
else claim "104ra the first of the two takes the last place" 0; fi
if grep -q "ERROR:  gallery_full" /tmp/cb_gal2.log; then claim "104rb the second is refused as full, not by chance" 0
else claim "104rb the second is refused as full, not by chance ($(grep -m1 ERROR /tmp/cb_gal2.log))" 1; fi
check service "104rc and the club ends with six, not seven"           "select count(*) from club_media where club_id='$CLUB' and kind='gallery';" 6
denied service "104s a caption over 80 characters is refused"         "select set_gallery_caption('$ADMIN',(select id from club_media where club_id='$CLUB' and kind='gallery' limit 1), repeat('x', 81));"
denied $ADMIN  "104t staff cannot set a caption from the browser"     "select set_gallery_caption('$ADMIN',(select id from club_media where club_id='$CLUB' and kind='gallery' limit 1), 'hi');"
# reordering against a stale screen must not silently drop a photo
G=$($PSQL -At -q -d $DB -c "select array_agg(id order by sort) from club_media where club_id='$CLUB' and kind='gallery'" | head -1)
denied service "104u reordering with a photo missing is refused"      "select reorder_club_gallery('$ADMIN','$CLUB', ('$G'::uuid[])[1:5]);"
denied service "104v reordering with one photo twice is refused"      "select reorder_club_gallery('$ADMIN','$CLUB', ('$G'::uuid[])[1:1] || ('$G'::uuid[])[1:5]);"
denied service "104w reordering with a blank in it is refused"        "select reorder_club_gallery('$ADMIN','$CLUB', ('$G'::uuid[])[1:5] || array[null]::uuid[]);"
denied service "104x reordering another club's photos is refused"     "select reorder_club_gallery('$STAFF_B','$CLUB', '$G'::uuid[]);"
check service "104y reordering with all of them works"                "select reorder_club_gallery('$ADMIN','$CLUB', '$G'::uuid[]); select string_agg(sort::text,',' order by sort) from club_media where club_id='$CLUB' and kind='gallery';" "0,1,2,3,4,5"
# removing closes the gap
RM=$($PSQL -At -q -d $DB -c "select id from club_media where club_id='$CLUB' and kind='gallery' order by sort limit 1" | head -1)
check service "104z removing returns the file to delete"              "select remove_club_media('$ADMIN','$RM') like 'clubs/%';" "t"
check service "104aa and the remaining photos are numbered 0..4"      "select string_agg(sort::text,',' order by sort) from club_media where club_id='$CLUB' and kind='gallery';" "0,1,2,3,4"
denied service "104ab a file still in use cannot be filed as unused"  "select record_media_orphan('$ADMIN','$CLUB',(select path from club_media where club_id='$CLUB' and kind='gallery' limit 1), 'test', true);"
denied service "104ac nor can another club's file be filed here"      "select record_media_orphan('$ADMIN','$CLUB','$(mpath $CLUB_B 21)','test', true);"
{ as_service; echo "select record_media_orphan('$ADMIN','$CLUB','$(mpath $CLUB 22)','test', true);"; } | $PSQL -q -d $DB >/dev/null
check service "104ad a file nothing points at is filed for cleanup"   "select count(*) from media_orphans where path='$(mpath $CLUB 22)';" 1
denied $P1     "104ae a player cannot list unused files"              "select count(*) from media_orphans_list();"
check $ADMIN   "104af an admin can"                                   "select count(*) >= 1 from media_orphans_list();" "t"
# A file recorded while its outcome was unknown may turn out to be referenced after all. The sweep
# list must not offer it for deletion, or the uncertainty just moves one step along.
{ as_service; echo "select record_media_orphan('$ADMIN','$CLUB','$(mpath $CLUB 23)','outcome unknown', false);"; } | $PSQL -q -d $DB >/dev/null
check $ADMIN   "104afa an unsure record is listed while nothing uses it" "select count(*) from media_orphans_list() where path='$(mpath $CLUB 23)';" 1
check $ADMIN   "104afc and is labelled as needing verification"        "select certain from media_orphans_list() where path='$(mpath $CLUB 23)';" "f"
check $ADMIN   "104afd while a terminal refusal is labelled safe"      "select certain from media_orphans_list() where path='$(mpath $CLUB 22)';" "t"
denied service "104afe recording without saying which is refused"      "select record_media_orphan('$ADMIN','$CLUB','$(mpath $CLUB 24)','test', null);"
$PSQL -q -d $DB -c "insert into club_media (club_id, kind, path, sort, created_by) values ('$CLUB','gallery','$(mpath $CLUB 23)', 9, '$ADMIN');" >/dev/null
check $ADMIN   "104afb and drops off the list once something does"    "select count(*) from media_orphans_list() where path='$(mpath $CLUB 23)';" 0
$PSQL -q -d $DB -c "delete from club_media where path='$(mpath $CLUB 23)'; delete from media_orphans where path='$(mpath $CLUB 23)';" >/dev/null
# who uploaded a photo is the club's business, not the public's
check anon     "104ag the photos themselves are public"               "select count(*) >= 1 from club_media where club_id='$CLUB';" "t"
denied anon    "104ah the uploader's identity is not"                 "select created_by from club_media limit 1;"
denied $P1     "104ai not even to a signed-in player"                 "select created_by from club_media limit 1;"
# an existing broad write policy on the bucket must not let anything in
denied $ADMIN  "104aj signed-in users cannot write to the bucket"     "insert into storage.objects (bucket_id, name) values ('club-media','clubs/$CLUB/x.webp');"
denied anon    "104ak nor can strangers"                              "insert into storage.objects (bucket_id, name) values ('club-media','clubs/$CLUB/y.webp');"
check $ADMIN   "104al and the broad policy still works elsewhere"     "insert into storage.objects (bucket_id, name) values ('avatars','me.png'); select count(*) from storage.objects where bucket_id='avatars';" 1
$PSQL -q -d $DB -c "insert into storage.objects (bucket_id, name) values ('club-media','$MP3');" >/dev/null
check $ADMIN   "104am deleting from the bucket removes nothing"       "delete from storage.objects where bucket_id='club-media'; select count(*) from storage.objects where bucket_id='club-media';" 1
check $ADMIN   "104an renaming in the bucket changes nothing"         "update storage.objects set name='hacked' where bucket_id='club-media'; select count(*) from storage.objects where name='hacked';" 0
# venue information, with three states
# Phase 11b. Three states, and the one that matters is null: a facility nobody has answered must
# never reach a player as "no". The address is its own field — a maps link is not something you can
# read out to a driver, and arrival notes are directions once you are already close.
check anon   "104av a new club has answered nothing"                  "select count(*) from clubs where id='$CLUB_B' and has_parking is null and facilities_confirmed_at is null;" 1
check $ADMIN "104aw staff can record an address"                      "select 'done' || coalesce((select set_club_venue('$CLUB','About us.','Behind the bakery.','Main road, Batroun', true, false, null, null, null, true, null))::text,''); select address from clubs where id='$CLUB';" "Main road, Batroun"
check anon   "104ax yes, no and unanswered are three distinct states" "select coalesce(has_parking::text,'?')||coalesce(has_changing_rooms::text,'?')||coalesce(has_showers::text,'?') from clubs where id='$CLUB';" "truefalse?"
check $ADMIN "104ay answering is dated, so silence is distinguishable" "select facilities_confirmed_at is not null from clubs where id='$CLUB';" "t"
check $ADMIN "104az blanks are stored as nothing, not as empty text"  "select 'done' || coalesce((select set_club_venue('$CLUB','   ','','  ', null,null,null,null,null,null,null))::text,''); select description is null and arrival_notes is null and address is null from clubs where id='$CLUB';" "t"
denied $ADMIN "104ba an address over 200 characters is refused"       "select set_club_venue('$CLUB', null, null, repeat('x',201), null,null,null,null,null,null,null);"
denied $P1   "104bb a player cannot write venue information"          "select set_club_venue('$CLUB','hack',null,null,null,null,null,null,null,null,null);"
# staff of a different club, created here because this is where it is first needed
STAFF_D=77777777-dddd-4ddd-8ddd-777777777777
$PSQL -q -d $DB -c "insert into auth.users (id, phone) values ('$STAFF_D','+9618') on conflict do nothing;
  insert into profiles (id, name) values ('$STAFF_D','Desk of another') on conflict do nothing;
  delete from club_staff where profile_id='$STAFF_D';
  insert into club_staff (club_id, profile_id) values ('$CLUB_B','$STAFF_D');" >/dev/null
denied $STAFF_D "104bc nor staff of another club"                     "select set_club_venue('$CLUB','hack',null,null,null,null,null,null,null,null,null);"
denied $ADMIN "104bd the old signature is gone, so nothing skips the address" "select set_club_venue('$CLUB','x','y',true,true,true,true,true,true,true);"
$PSQL -q -d $DB -c "update clubs set description=null, arrival_notes=null, address=null, has_parking=null, has_changing_rooms=null, has_showers=null, facilities_confirmed_at=null where id='$CLUB';" >/dev/null
check $ADMIN "104ao facilities start unconfirmed"                     "select facilities_confirmed_at is null from clubs where id='$CLUB_B';" "t"
check $ADMIN "104ap staff record yes, no and not-confirmed"           "select set_club_venue('$CLUB','A friendly club.','Gate on the main road.','Main road', true, true, null, false, null, true, true); select coalesce(has_parking::text,'?')||coalesce(has_showers::text,'?')||coalesce(has_equipment_rental::text,'?') from clubs where id='$CLUB';" "true?false"
check service "104aq and the answer is dated"                         "select facilities_confirmed_at is not null from clubs where id='$CLUB';" "t"
denied $P1 "104ar a player cannot change venue information"           "select set_club_venue('$CLUB','hack',null,null,null,null,null,null,null,null,null);"
denied $ADMIN "104as a description over 600 characters is refused"    "select set_club_venue('$CLUB', repeat('x',601), null,null,null,null,null,null,null,null,null);"

echo "--- AK. money reporting tells real money from simulated (Phase 12 finding)"
# The dashboard reported simulated payments as collected, told a club it was owed $310, and offered a
# payout button for money nobody had paid. `payments.collected` existed the whole time and neither
# reporting function used it. These checks assert the distinction the data always carried.
PB1=$($PSQL -At -q -d $DB -c "select id from bookings where club_id='$CLUB' and status='confirmed' order by created_at limit 1" | head -1)
PB2=$($PSQL -At -q -d $DB -c "select id from bookings where club_id='$CLUB' and status='confirmed' order by created_at offset 1 limit 1" | head -1)
$PSQL -q -d $DB -c "delete from payments where club_id='$CLUB'; delete from club_payouts where club_id='$CLUB';
  insert into payments (booking_id, profile_id, club_id, provider, amount_usd, fee_usd, total_usd, status, paid_at, collected)
  values ('$PB1','$P1','$CLUB','simulated', 20, 1, 21, 'paid', now(), false),
         ('$PB2','$P1','$CLUB','whish',     30, 1, 31, 'paid', now(), true);" >/dev/null
check $ADMIN "105a only collected money is reported as collected"      "select gross from payments_summary(date_trunc('month', now())::date) where club_id='$CLUB';" "31.00"
check $ADMIN "105b and only collected fees are earned"                 "select fees from payments_summary(date_trunc('month', now())::date) where club_id='$CLUB';" "1.00"
check $ADMIN "105c simulated money is shown, separately"               "select simulated_bookings || '/' || simulated_total from payments_summary(date_trunc('month', now())::date) where club_id='$CLUB';" "1/21.00"
check $ADMIN "105d a club is owed only what was actually taken"        "select club_share from club_balances() where club_id='$CLUB';" "30.00"
check $ADMIN "105e and simulated share is reported apart from it"      "select simulated_share from club_balances() where club_id='$CLUB';" "20.00"
# the case that was on the screen: nothing real collected at all
$PSQL -q -d $DB -c "update payments set collected = false where club_id='$CLUB';" >/dev/null
check $ADMIN "105f with only simulated money, the club is owed nothing" "select outstanding from club_balances() where club_id='$CLUB';" "0"
check $ADMIN "105g and nothing reads as collected"                     "select gross from payments_summary(date_trunc('month', now())::date) where club_id='$CLUB';" "0"
# A payout can exceed what was collected — a mistake, or a refund after the money went out. The
# balance must go negative and stay negative: clamping it to zero would hide money that left.
$PSQL -q -d $DB -c "insert into club_payouts (club_id, amount_usd, method, created_by) values ('$CLUB', 25, 'cash', '$ADMIN');" >/dev/null
check $ADMIN "105h paying out more than was collected goes negative"   "select outstanding from club_balances() where club_id='$CLUB';" "-25.00"
$PSQL -q -d $DB -c "delete from payments where club_id='$CLUB'; delete from club_payouts where club_id='$CLUB';" >/dev/null

# A cancelled simulated booking is not money anybody is owed. cancel_booking still marks the payment
# refund_due — that is the booking's truth — but `collected` decides what counts as an obligation.
$PSQL -q -d $DB -c "delete from payments where club_id='$CLUB';
  insert into payments (booking_id, profile_id, club_id, provider, amount_usd, fee_usd, total_usd, status, paid_at, collected)
  values ('$PB1','$P1','$CLUB','simulated', 20, 1, 21, 'refund_due', now(), false),
         ('$PB2','$P1','$CLUB','whish',     30, 1, 31, 'refund_due', now(), true);" >/dev/null
check $ADMIN "105i only real money reaches the refund queue"           "select count(*) from refunds_due() where club_id='$CLUB';" 1
check $ADMIN "105j and the queue holds the one that was collected"     "select total_usd from refunds_due() where club_id='$CLUB';" "31.00"
check $ADMIN "105k the badge counts real obligations only"             "select refunds_due from payments_summary(date_trunc('month', now())::date) where club_id='$CLUB';" 1
check $ADMIN "105l simulated cancellations are counted apart"          "select simulated_refunds from payments_summary(date_trunc('month', now())::date) where club_id='$CLUB';" 1
SIMP=$($PSQL -At -q -d $DB -c "select id from payments where club_id='$CLUB' and not collected" | head -1)
REALP=$($PSQL -At -q -d $DB -c "select id from payments where club_id='$CLUB' and collected" | head -1)
denied $ADMIN "105m a refund cannot be recorded on uncollected money"  "select mark_refunded('$SIMP');"
# The person handing the money back is at the desk, not at head office, so club staff do this for
# their own club. 0012 had it admin-only, 0017 widened it, and a draft of 0061 narrowed it again.
# Two identities of this block's own, rather than relying on who is staff of what by now.
STAFF_C=66666666-cccc-4ccc-8ccc-666666666666
$PSQL -q -d $DB -c "insert into auth.users (id, phone) values ('$STAFF_C','+9617') on conflict do nothing;
  insert into profiles (id, name) values ('$STAFF_C','Desk of this club') on conflict do nothing;
  delete from club_staff where profile_id='$STAFF_C';
  insert into club_staff (club_id, profile_id) values ('$CLUB','$STAFF_C');" >/dev/null
denied $STAFF_D "105n nor by staff of a different club"                "select mark_refunded('$REALP');"
denied $P1     "105o nor by a player"                                  "select mark_refunded('$REALP');"
# reset it, so this check stands on its own rather than on 105m having already consumed the row
$PSQL -q -d $DB -c "update payments set status='refund_due', refunded_at=null where id='$SIMP';" >/dev/null
denied $STAFF_C "105p staff cannot refund uncollected money either"    "select mark_refunded('$SIMP');"
check $STAFF_C "105q but staff can complete their own club's refund"   "select 'done' || coalesce((select mark_refunded('$REALP'))::text,'');" "done"
check $ADMIN   "105r and it is recorded as refunded"                   "select status from payments where id='$REALP';" "refunded"

# Payouts: the form used to insert straight into the table from the browser, with the amount and the
# author both supplied by the client. Only the server knows what a club is owed.
$PSQL -q -d $DB -c "delete from payments where club_id='$CLUB'; delete from club_payouts where club_id='$CLUB';
  insert into payments (booking_id, profile_id, club_id, provider, amount_usd, fee_usd, total_usd, status, paid_at, collected)
  values ('$PB1','$P1','$CLUB','whish', 40, 1, 41, 'paid', now(), true);" >/dev/null
denied $ADMIN "105s the browser cannot write a payout directly"        "insert into club_payouts (club_id, amount_usd, method, created_by) values ('$CLUB', 10, 'Cash', '$ADMIN');"
denied $ADMIN "105t nor pay out more than the club is owed"            "select record_club_payout('$CLUB', 40.01, 'Cash', null);"
denied $ADMIN "105u nor a negative amount"                             "select record_club_payout('$CLUB', -5, 'Cash', null);"
denied $P1    "105v and a player cannot record one at all"             "select record_club_payout('$CLUB', 10, 'Cash', null);"
check $ADMIN "105w a payout within the balance is recorded"            "select record_club_payout('$CLUB', 40, 'Cash', 'ref-1') is not null;" "t"
check $ADMIN "105x and it is attributed to whoever recorded it"        "select created_by = '$ADMIN' from club_payouts where club_id='$CLUB';" "t"
check $ADMIN "105y leaving nothing outstanding"                        "select outstanding from club_balances() where club_id='$CLUB';" "0.00"
denied $ADMIN "105z so a second payout is refused"                     "select record_club_payout('$CLUB', 1, 'Cash', null);"
$PSQL -q -d $DB -c "delete from payments where club_id='$CLUB'; delete from club_payouts where club_id='$CLUB';" >/dev/null

check $ADMIN "104at settings are not readable from a browser"         "select count(*) from app_settings;" 0
check service "104au but the server has the storage address"          "select value like 'https://%' from app_settings where key='storage_base_url';" "t"
# --- AL. the recovery procedure the status doc promises ------------------------------------------
# "If a migration ever needs re-running, re-run everything from that number onwards, in order."
# That is only true if each file is safe to apply twice, and 0061 shipped a create policy without a
# drop, which failed on Paul's database. Applying them all a second time is the cheapest way to keep
# the promise honest. 0040 is excluded: it adds an enum value and must run alone.
echo "--- AL. every migration from 0041 can be applied twice"
# What this asserts: re-application raises no error. It does NOT assert that a second application
# leaves the data identical — a migration that rewrites rows would pass this and still change them.
# Every check above runs against a singly-applied database, so that stronger property is untested.
RERUN_FAILS=""
for f in $(ls supabase/migrations/*.sql | sort); do
  n=$(basename "$f")
  case "$n" in 00[0-3]*|0040_*) continue;; esac
  err=$($PSQL -d $DB -v ON_ERROR_STOP=1 -1 -f "$f" 2>&1 >/dev/null | grep -m1 ERROR)
  [ -n "$err" ] && RERUN_FAILS="$RERUN_FAILS\n    $n → $err"
done
if [ -z "$RERUN_FAILS" ]; then claim "106a re-applying 0041 onwards raises no error" 0
else claim "106a re-applying 0041 onwards raises no error$(printf "$RERUN_FAILS")" 1; fi
# Succeeding is not the same as landing in the same place. 0056 grants table-level select on
# club_media and 0057 takes it away again; applied in order the result is right, but only because
# of the order. These two assert the end state rather than trusting it.
check service "106b and the uploader is still not public afterwards"  "select has_column_privilege('anon','club_media','created_by','SELECT');" "f"
check service "106c and publication is still server-only afterwards"  "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('set_club_image','add_club_gallery','reorder_club_gallery','set_gallery_caption','remove_club_media','record_media_orphan') and has_function_privilege('authenticated', p.oid, 'EXECUTE');" 0

echo
echo "checks: $CHECKS, failures: $FAILS"
[ "$FAILS" -eq 0 ] || { echo "SUITE FAILED"; exit 1; }
echo "SUITE OK"
