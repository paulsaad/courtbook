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
M=$({ as_user $P1; echo "select post_match('$CLUB','padel', now()+interval '2 day', now()+interval '2 day 90 min', 'intermediate', 2, 'Need 2 for doubles', null);"; } | $PSQL -At -d $DB | tail -1)
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
select post_match(null,'padel',null,null,null,3,'from booking','99999999-9999-4999-8999-999999999999') as linked \gset
select club_id = '$CLUB' and start_at = (select start_at from bookings where id='99999999-9999-4999-8999-999999999999') from matches where id = :'linked';
EOF
as_user $P2; cat <<EOF
select post_match(null,'padel',null,null,null,3,'x','99999999-9999-4999-8999-999999999999');
EOF
} | $PSQL -d $DB 2>&1 | filter

echo "--- U. join approval, notifications, chat"
MA=$({ as_user $P1; echo "select post_match('$CLUB','padel', now()+interval '4 day', now()+interval '4 day 90 min', null, 1, 'approval match', null, 'approval');"; } | $PSQL -At -d $DB | tail -1)
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
MB=$({ as_user $P1; echo "select post_match('$CLUB','padel', now()+interval '5 day', now()+interval '5 day 90 min', null, 2, 'two spots', null, 'approval');"; } | $PSQL -At -d $DB | tail -1)
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
select post_match(null,'tennis',null,null,null,2,'x','99999999-9999-4999-8999-999999999999');
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
pm() { { as_user $P1; echo "begin; select post_match(null,'padel',null,null,null,3,'race $2','$BK'); select pg_sleep(1); commit;"; } | $PSQL -d $DB > /tmp/cb_pm$2.log 2>&1; }
pm x 1 & sleep 0.3; pm x 2 & wait
grep -h "ERROR" /tmp/cb_pm1.log /tmp/cb_pm2.log | sort | uniq -c
$PSQL -At -d $DB -c "select 'live matches on booking = '||count(*)||' (expect 1)' from matches where booking_id='$BK' and status<>'cancelled'"
echo "71. cancel the match, repost -> allowed (index is partial)"
{ as_user $P1; echo "select set_match_status((select id from matches where booking_id='$BK'),'cancelled'); select post_match(null,'padel',null,null,null,3,'repost','$BK') is not null;"; } | $PSQL -At -d $DB 2>&1 | tail -1
echo "72. post_match races booking cancellation -> either booking_not_found, or match created then unlinked by trigger (never a live link to a cancelled booking)"
{ as_user $P1; echo "select set_match_status((select id from matches where booking_id='$BK' and status<>'cancelled'),'cancelled');"; } | $PSQL -q -d $DB
{ as_user $P1; echo "begin; select cancel_booking('$BK'); select pg_sleep(1); commit;"; } | $PSQL -d $DB > /tmp/cb_cx.log 2>&1 &
sleep 0.3; { as_user $P1; echo "select post_match(null,'padel',null,null,null,3,'late post','$BK');"; } | $PSQL -d $DB > /tmp/cb_lp.log 2>&1; wait
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
