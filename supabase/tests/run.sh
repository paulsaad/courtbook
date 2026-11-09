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
STAFF_B=44444444-4444-4444-4444-444444444444   # staff of a second club

$PSQL -q -c "drop database if exists $DB" -c "create database $DB" >/dev/null
MIG=$(ls supabase/migrations/*.sql | sort | sed 's/^/-f /' | tr '\n' ' ')
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql $MIG -f supabase/seed.sql \
  || { echo "MIGRATION FAILED"; exit 1; }
echo "migrations + seed: OK"

$PSQL -q -d $DB -v ON_ERROR_STOP=1 <<EOF
insert into auth.users (id, phone) values ('$P1','+9611'), ('$P2','+9612'), ('$ADMIN','+9613'), ('$STAFF_B','+9614');
update profiles set roles='{player,admin}' where id='$ADMIN';
insert into credit_transactions (profile_id, delta, kind) values ('$P1',1,'purchase'), ('$P2',1,'purchase');
insert into clubs (name, slug) values ('Other Club', 'other');
insert into courts (club_id, name, sport) select id, 'Other 1', 'padel' from clubs where slug='other';
insert into club_staff (club_id, profile_id) select id, '$STAFF_B' from clubs where slug='other';
EOF
COURT=$($PSQL -At -d $DB -c "select id from courts where name='Padel 1'")
COURT2=$($PSQL -At -d $DB -c "select id from courts where name='Padel 2'")
CLUB=$($PSQL -At -d $DB -c "select id from clubs where slug='batroun'")
CLUB_B=$($PSQL -At -d $DB -c "select id from clubs where slug='other'")
# Grid-aligned slot: tomorrow 09:30-11:00 Beirut (club opens 08:00, 90-min slots)
S="(current_date + 1 + time '09:30') at time zone 'Asia/Beirut'"
E="(current_date + 1 + time '11:00') at time zone 'Asia/Beirut'"
as_user() { echo "set role authenticated; select set_config('request.jwt.claim.sub','$1',false);"; }
filter() { grep -vE "^(SET|UPDATE|INSERT|set_config|-+|\(1 row\)|\s*$|CONTEXT|LINE|\s+\^| 1111| 2222| 3333| 4444| set_config|PL/pgSQL|SQL statement)"; }

echo "--- A. concurrent double booking: two players, same slot, overlapping transactions"
book() { { as_user $1; echo "begin; select book_slot('$CLUB','$2',null, $S, $E); select pg_sleep(1.5); commit;"; } | $PSQL -d $DB 2>&1; }
book $P1 $COURT > /tmp/cb_p1.log & sleep 0.4; book $P2 $COURT > /tmp/cb_p2.log & wait
grep -q "ERROR:  slot_taken" /tmp/cb_p2.log && echo "loser got slot_taken: OK" || { echo "FAIL: second booking not rejected"; cat /tmp/cb_p2.log; }
$PSQL -At -d $DB -c "select 'confirmed bookings = '||count(*)||' (expect 1)' from bookings where status='confirmed'"
$PSQL -At -d $DB -c "select 'balances p1,p2 = '||credit_balance('$P1')||','||credit_balance('$P2')||' (expect 0,1)'"
B=$($PSQL -At -d $DB -c "select id from bookings where status='confirmed' limit 1")

echo "--- B. same player, one credit, two different courts concurrently (review #1)"
$PSQL -q -d $DB -c "insert into credit_transactions (profile_id, delta, kind) values ('$P1',1,'purchase')"
S2="(current_date + 2 + time '09:30') at time zone 'Asia/Beirut'"; E2="(current_date + 2 + time '11:00') at time zone 'Asia/Beirut'"
book2() { { as_user $P1; echo "begin; select book_slot('$CLUB','$1',null, $S2, $E2); select pg_sleep(1.5); commit;"; } | $PSQL -d $DB 2>&1; }
book2 $COURT > /tmp/cb_b1.log & sleep 0.4; book2 $COURT2 > /tmp/cb_b2.log & wait
grep -q "insufficient_credits" /tmp/cb_b2.log && echo "second got insufficient_credits: OK" || { echo "FAIL: balance race"; cat /tmp/cb_b2.log; }
$PSQL -At -d $DB -c "select 'p1 balance = '||credit_balance('$P1')||' (expect 0, never negative)'"

echo "--- C. rules"
{ as_user $ADMIN; cat <<EOF
\set ON_ERROR_STOP off
\echo '1. block over existing booking -> expect ERROR block_overlaps_booking'
insert into blocks (club_id, court_id, start_at, end_at, reason, created_by) values ('$CLUB','$COURT', $S, $S + interval '60 min','maint','$ADMIN');
\echo '2. block a free window -> expect no error'
insert into blocks (club_id, court_id, start_at, end_at, reason, created_by) values ('$CLUB','$COURT', (current_date + 3 + time '08:00') at time zone 'Asia/Beirut', (current_date + 3 + time '12:30') at time zone 'Asia/Beirut','tournament','$ADMIN');
EOF
as_user $P2; cat <<EOF
\echo '3. player2 books inside the block -> expect ERROR slot_taken'
select book_slot('$CLUB','$COURT',null, (current_date + 3 + time '09:30') at time zone 'Asia/Beirut', (current_date + 3 + time '11:00') at time zone 'Asia/Beirut');
\echo '4. bad duration (60 min at a 90-min club) -> expect ERROR bad_duration'
select book_slot('$CLUB','$COURT2',null, $S, $S + interval '60 min');
\echo '5. off-grid start (09:45) -> expect ERROR not_on_grid'
select book_slot('$CLUB','$COURT2',null, $S + interval '15 min', $E + interval '15 min');
\echo '6. before opening (06:30) -> expect ERROR outside_opening_hours'
select book_slot('$CLUB','$COURT2',null, (current_date + 1 + time '06:30') at time zone 'Asia/Beirut', (current_date + 1 + time '08:00') at time zone 'Asia/Beirut');
\echo '7. court from another club -> expect ERROR court_not_found'
select book_slot('$CLUB_B','$COURT2',null, $S, $E);
\echo '8. coach path -> expect ERROR coach_booking_not_available'
select book_slot('$CLUB',null,'$P1', $S, $E);
\echo '9. player2 visible rows in bookings -> expect 0 ; occupancy -> expect 3 rows, 0 ids'
select count(*) from bookings; select count(*) as rows, count(id) as ids from occupancy;
\echo '10. self-promote -> expect roles {player}'
update profiles set roles='{player,admin}' where id=auth.uid(); select roles from profiles where id=auth.uid();
\echo '11. cancel someone else booking -> expect ERROR forbidden'
select cancel_booking('$B');
\echo '12. direct credit insert -> expect ERROR row-level security'
insert into credit_transactions (profile_id, delta, kind) values (auth.uid(), 100, 'purchase');
\echo '13. read another players balance -> expect ERROR forbidden'
select credit_balance('$P1');
EOF
as_user $STAFF_B; cat <<EOF
\echo '14. staff of club B inserts a booking on club A court with club_id=B -> expect ERROR court_not_found (trigger; FK is the backstop)'
insert into bookings (club_id, court_id, guest_name, start_at, end_at, source, created_by) values ('$CLUB_B','$COURT2','Walk-in', $S, $E, 'staff', auth.uid());
\echo '15. staff of club B updates club A booking directly -> expect UPDATE 0 (no policy)'
update bookings set status='cancelled' where id='$B';
\echo '16. staff of club B moves club A booking -> expect ERROR forbidden'
select move_booking('$B','$COURT2', $S, $E);
EOF
as_user $ADMIN; cat <<EOF
\echo '17. admin (staff) moves booking to Padel 2 -> expect no error'
select move_booking('$B','$COURT2', $S, $E);
\echo '18. admin direct update -> expect UPDATE 0 (policy removed for everyone)'
update bookings set status='cancelled' where id='$B';
\echo '17b. move to 02:00 (closed) -> expect ERROR outside_opening_hours'
select move_booking('$B','$COURT2', (current_date + 1 + time '02:00') at time zone 'Asia/Beirut', (current_date + 1 + time '03:30') at time zone 'Asia/Beirut');
\echo '17c. move to 4h (not a multiple of 90) -> expect ERROR bad_duration'
select move_booking('$B','$COURT2', $S, $S + interval '4 hour');
\echo '17d. move off-grid 09:45 -> expect ERROR not_on_grid'
select move_booking('$B','$COURT2', $S + interval '15 min', $E + interval '15 min');
\echo '17e. staff extends to 3h (2 slots) -> expect no error ; then back to 1 slot'
select move_booking('$B','$COURT2', $S, $S + interval '3 hour'); select move_booking('$B','$COURT2', $S, $E);
\echo '17f. staff insert walk-in at 21:30-23:00 (ends at close) -> expect no error'
insert into bookings (club_id, court_id, guest_name, guest_phone, start_at, end_at, source, created_by) values ('$CLUB','$COURT','Walk-in','+961', (current_date + 1 + time '21:30') at time zone 'Asia/Beirut', (current_date + 1 + time '23:00') at time zone 'Asia/Beirut', 'staff', auth.uid());
EOF
as_user $P2; cat <<EOF
\echo '18b. player passes club_caused=true -> expect ERROR forbidden'
select cancel_booking('$B', true);
EOF
as_user $P1; cat <<EOF
\echo '19. player1 cancels own booking >12h ahead -> expect balance 1'
select cancel_booking('$B'); select credit_balance(auth.uid());
\echo '20. anon reads clubs -> expect 2 ; anon occupancy -> expect permission denied ; anon cancel -> expect permission denied'
set role anon; select count(*) from clubs; select count(*) from occupancy; select cancel_booking('$B');
EOF
} | $PSQL -d $DB 2>&1 | filter

echo "--- D. cancellation reason vs role (review round 2, #2)"
# Admin (staff) holds two personal app bookings tomorrow 09:30; cutoff raised to 48h so they are inside it.
B5=55555555-5555-5555-5555-555555555555; B6=66666666-6666-6666-6666-666666666666
$PSQL -q -d $DB -v ON_ERROR_STOP=1 <<EOF
update clubs set cancel_cutoff_hours = 48 where id = '$CLUB';
insert into credit_transactions (profile_id, delta, kind) values ('$ADMIN', 2, 'purchase');
with tx as (insert into credit_transactions (profile_id, delta, kind, created_by) values ('$ADMIN',-1,'booking','$ADMIN') returning id)
insert into bookings (id, club_id, court_id, player_id, start_at, end_at, source, credit_tx_id, created_by)
select '$B5','$CLUB',(select id from courts where name='Padel 3'),'$ADMIN', $S, $E, 'app', tx.id, '$ADMIN' from tx;
with tx as (insert into credit_transactions (profile_id, delta, kind, created_by) values ('$ADMIN',-1,'booking','$ADMIN') returning id)
insert into bookings (id, club_id, court_id, player_id, start_at, end_at, source, credit_tx_id, created_by)
select '$B6','$CLUB',(select id from courts where name='Tennis 1'),'$ADMIN', $S, $E, 'app', tx.id, '$ADMIN' from tx;
EOF
{ as_user $ADMIN; cat <<EOF
\set ON_ERROR_STOP off
\echo '21. staff cancels own personal booking inside cutoff, not club-caused -> expect balance 0'
select cancel_booking('$B5'); select credit_balance(auth.uid());
\echo '22. staff cancels own booking inside cutoff, club-caused -> expect balance 1'
select cancel_booking('$B6', true); select credit_balance(auth.uid());
EOF
} | $PSQL -d $DB 2>&1 | filter
