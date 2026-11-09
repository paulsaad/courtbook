#!/usr/bin/env bash
# Local test of the schema: applies migration + seed to a scratch Postgres database
# (with a minimal shim of Supabase's auth schema and grants) and checks the booking rules.
# Usage: PSQL="psql -U postgres" supabase/tests/run.sh
set -u
cd "$(dirname "$0")/../.."
PSQL=${PSQL:-psql}
DB=courtbook_test
P1=11111111-1111-1111-1111-111111111111
P2=22222222-2222-2222-2222-222222222222
ADMIN=33333333-3333-3333-3333-333333333333

$PSQL -q -c "drop database if exists $DB" -c "create database $DB" >/dev/null
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql \
  -f supabase/migrations/0001_init.sql -f supabase/seed.sql || { echo "MIGRATION FAILED"; exit 1; }
echo "migration + seed: OK"

$PSQL -q -d $DB -v ON_ERROR_STOP=1 <<EOF
insert into auth.users (id, phone) values ('$P1','+9611'), ('$P2','+9612'), ('$ADMIN','+9613');
update profiles set roles='{player,admin}' where id='$ADMIN';
insert into credit_transactions (profile_id, delta, kind) values ('$P1',1,'purchase'), ('$P2',1,'purchase');
EOF
COURT=$($PSQL -At -d $DB -c "select id from courts where name='Padel 1'")
CLUB=$($PSQL -At -d $DB -c "select id from clubs where slug='batroun'")
as_user() { echo "set role authenticated; select set_config('request.jwt.claim.sub','$1',false);"; }

echo "--- concurrent double booking: two players, same slot, overlapping transactions"
book() { { as_user $1; echo "begin; select book_slot('$CLUB','$COURT',null, now()+interval '1 day', now()+interval '1 day 90 min'); select pg_sleep(1.5); commit;"; } | $PSQL -d $DB 2>&1; }
book $P1 > /tmp/cb_p1.log & sleep 0.4; book $P2 > /tmp/cb_p2.log & wait
grep -q "ERROR:  slot_taken" /tmp/cb_p2.log && echo "loser got slot_taken: OK" || { echo "FAIL: second booking not rejected"; cat /tmp/cb_p2.log; }
$PSQL -At -d $DB -c "select 'confirmed bookings = '||count(*)||' (expect 1)' from bookings where status='confirmed'"
$PSQL -At -d $DB -c "select 'balances p1,p2 = '||credit_balance('$P1')||','||credit_balance('$P2')||' (expect 0,1)'"
B=$($PSQL -At -d $DB -c "select id from bookings where status='confirmed' limit 1")

echo "--- rules"
{ as_user $ADMIN; cat <<EOF
\set ON_ERROR_STOP off
\echo '1. block over existing booking -> expect ERROR block_overlaps_booking'
insert into blocks (club_id, court_id, start_at, end_at, reason, created_by) values ('$CLUB','$COURT', now()+interval '1 day', now()+interval '1 day 60 min','maint','$ADMIN');
\echo '2. block a free window -> expect INSERT 0 1'
insert into blocks (club_id, court_id, start_at, end_at, reason, created_by) values ('$CLUB','$COURT', now()+interval '2 day', now()+interval '2 day 180 min','tournament','$ADMIN');
EOF
as_user $P2; cat <<EOF
\echo '3. player2 books inside the block -> expect ERROR slot_taken (block trigger uses the exclusion error class)'
select book_slot('$CLUB','$COURT',null, now()+interval '2 day 90 min', now()+interval '2 day 180 min');
\echo '4. player2 visible rows in bookings -> expect 0 ; occupancy -> expect 2'
select count(*) from bookings; select count(*) from occupancy;
\echo '5. self-promote -> expect roles {player}'
update profiles set roles='{player,admin}' where id=auth.uid(); select roles from profiles where id=auth.uid();
\echo '6. cancel someone else booking -> expect ERROR forbidden'
select cancel_booking('$B');
\echo '7. direct credit insert -> expect ERROR row-level security'
insert into credit_transactions (profile_id, delta, kind) values (auth.uid(), 100, 'purchase');
EOF
as_user $P1; cat <<EOF
\echo '8. player1 cancels own booking >12h ahead -> expect balance 1'
select cancel_booking('$B'); select credit_balance(auth.uid());
\echo '9. anon reads clubs -> expect 1'
set role anon; select count(*) from clubs;
EOF
} | $PSQL -d $DB 2>&1 | grep -vE "^(SET|UPDATE|set_config|-+|\(1 row\)|\s*$|CONTEXT|LINE|\s+\^| 1111| 2222| 3333| set_config)"
