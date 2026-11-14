#!/usr/bin/env bash
# Booking protections, checked on the real staging database (Supabase, through the pooler) rather
# than the local shim. Usage: DB=<staging connection string> bash supabase/tests/staging_smoke.sh
#
# Two throwaway players are created, everything they make is deleted at the end (and at the start,
# in case an earlier run stopped half-way), and the demo club's payment mode is put back. It refuses
# the live project. Section S2 runs only if hold_slot takes a retry token (migration 0065).
set -u
: "${DB:?set DB}"
case "$DB" in *lgujfbwunokobjxlvpuf*) echo "refusing: this is the LIVE project"; exit 1;; esac
PSQL="psql $DB -v ON_ERROR_STOP=1"
U1=5a0e0001-0000-4000-8000-000000000001
U2=5a0e0001-0000-4000-8000-000000000002
FAILS=0; CHECKS=0
as() { echo "set role authenticated; set request.jwt.claim.sub = '$1';"; }
# runs one statement as anon / admin (postgres) / a player; prints the first ERROR line if any, else the last output line
q() { local out e; out=$({ echo "\\set QUIET on"; [ "$1" = anon ] && echo "set role anon;" || [ "$1" = admin ] || as "$1"; echo "$2"; } | psql "$DB" -At 2>&1 | grep -v '^$')
  e=$(echo "$out" | grep -m1 ERROR); if [ -n "$e" ]; then echo "$e"; else echo "$out" | tail -1; fi; }
check() { CHECKS=$((CHECKS+1)); local got; got=$(q "$1" "$3"); if [ "$got" == "$4" ]; then echo "  ok    $2"; else echo "  FAIL  $2 — expected [$4] got [$got]"; FAILS=$((FAILS+1)); fi; }
fails_with() { CHECKS=$((CHECKS+1)); local got; got=$(q "$1" "$3"); if echo "$got" | grep -q "$4"; then echo "  ok    $2 ($4)"; else echo "  FAIL  $2 — expected an error containing [$4], got [$got]"; FAILS=$((FAILS+1)); fi; }

CLUB=$(q admin "select id from clubs where slug='batroun'")
COURT=$(q admin "select id from courts where club_id='$CLUB' and name='Padel 1'")
COURT2=$(q admin "select id from courts where club_id='$CLUB' and name='Padel 2'")
COURT3=$(q admin "select id from courts where club_id='$CLUB' and name='Padel 3'")
MODE=$(q admin "select payment_mode from clubs where id='$CLUB'")
MINB=$(q admin "select min_booking_minutes from clubs where id='$CLUB'")
[ -n "$COURT" ] || { echo "demo club or court missing"; exit 1; }
at() { echo "((current_date + 2 + time '$1') at time zone 'Asia/Beirut')"; }

cleanup() {
  { echo "\\set QUIET on"; cat <<SQL
delete from payments where booking_id in (select id from bookings where player_id in ('$U1','$U2') or created_by in ('$U1','$U2'));
delete from bookings where player_id in ('$U1','$U2') or created_by in ('$U1','$U2');
delete from club_staff where profile_id in ('$U1','$U2');
delete from auth.users where id in ('$U1','$U2');
update clubs set payment_mode = '$MODE', min_booking_minutes = $MINB where id = '$CLUB';
SQL
  } | psql "$DB" -v ON_ERROR_STOP=1 -q >/dev/null
}
cleanup
trap cleanup EXIT
$PSQL -q -c "insert into auth.users (id, email, aud, role) values ('$U1','smoke1@courtbook.test','authenticated','authenticated'), ('$U2','smoke2@courtbook.test','authenticated','authenticated');" >/dev/null || { echo "could not create test users"; exit 1; }

echo "--- S1. pay at the club (book_at_desk), the native app's path today"
$PSQL -q -c "update clubs set payment_mode='at_desk' where id='$CLUB';" >/dev/null
T1=$(q admin "select gen_random_uuid()"); T2=$(q admin "select gen_random_uuid()")
desk() { { as "$1"; echo "begin; select booking_id from book_at_desk('$COURT', $(at 10:00), $(at 11:30), '$2'); select pg_sleep(1.5); commit;"; } | psql "$DB" -At 2>&1; }
desk $U1 "$T1" > /tmp/s1a.log & sleep 0.4; desk $U2 "$T2" > /tmp/s1b.log & wait
CHECKS=$((CHECKS+1)); if grep -qE '^[0-9a-f-]{36}$' /tmp/s1a.log && grep -q "slot_taken" /tmp/s1b.log; then echo "  ok    S1a two players, same court and time, at once: one booking, the other slot_taken"; else echo "  FAIL  S1a"; cat /tmp/s1a.log /tmp/s1b.log; FAILS=$((FAILS+1)); fi
B1=$(grep -m1 -E '^[0-9a-f-]{36}$' /tmp/s1a.log)
check admin "S1b exactly one active booking on that court and time" "select count(*) from bookings where court_id='$COURT' and start_at=$(at 10:00) and status='confirmed';" 1
check $U1 "S1c a retry with the same token returns the same booking, marked as a replay" "select booking_id||'/'||already from book_at_desk('$COURT', $(at 10:00), $(at 11:30), '$T1');" "$B1/true"
check admin "S1d still one booking for that token" "select count(*) from bookings where player_id='$U1' and client_token='$T1';" 1
fails_with $U1 "S1e same token, different time: refused" "select book_at_desk('$COURT', $(at 14:00), $(at 15:00), '$T1');" token_reused
check $U1 "S1f the player finds the booking by its token (the app's reconciliation read)" "select id||'/'||status from bookings where client_token='$T1';" "$B1/confirmed"
check $U2 "S1g another player cannot see it by that token" "select count(*) from bookings where client_token='$T1';" 0
check $U1 "S1h price stored is the server's quote (1 h 30 off-peak at \$20/h)" "select price_usd from bookings where id='$B1';" 30.00
fails_with $U2 "S1i another player cannot cancel it" "select cancel_booking('$B1', false);" forbidden
CHECKS=$((CHECKS+1)); got=$(q $U2 "with u as (update bookings set status='cancelled' where id='$B1' returning 1) select count(*) from u;")
case "$got" in 0|*"permission denied"*) echo "  ok    S1j a player cannot write bookings directly ($got)";; *) echo "  FAIL  S1j got [$got]"; FAILS=$((FAILS+1));; esac
check admin "S1k ...and it is still confirmed" "select status from bookings where id='$B1';" confirmed
check $U1 "S1l the owner cancels" "select cancel_booking('$B1', false)::text || 'done';" done
check admin "S1m now cancelled" "select status from bookings where id='$B1';" cancelled
fails_with $U1 "S1n cancelling again: not active (what the app re-reads after a lost reply)" "select cancel_booking('$B1', false);" not_confirmed
fails_with anon "S1o a visitor cannot book" "select book_at_desk('$COURT', $(at 16:00), $(at 17:00), gen_random_uuid());" "permission denied"
check $U2 "S1p the freed slot can be booked again" "select (select count(*) from book_at_desk('$COURT', $(at 10:00), $(at 11:30), gen_random_uuid()));" 1

echo "--- S2. retry token on hold_slot (migration 0065), the in-app payment path"
HAS_TOKEN=$(q admin "select count(*) from pg_proc where proname='hold_slot' and pronamespace='public'::regnamespace and pg_get_function_identity_arguments(oid) like '%p_token%'")
check admin "S2a exactly one hold_slot (no overload for PostgREST to trip on)" "select count(*) from pg_proc where proname='hold_slot' and pronamespace='public'::regnamespace;" 1
if [ "$HAS_TOKEN" = "1" ]; then
  $PSQL -q -c "update clubs set payment_mode='simulated' where id='$CLUB';" >/dev/null
  T3=$(q admin "select gen_random_uuid()")
  H1=$(q $U1 "select booking_id||'/'||already from hold_slot('$CLUB','$COURT2', $(at 18:00), $(at 19:00), '$T3');")
  H2=$(q $U1 "select booking_id||'/'||already from hold_slot('$CLUB','$COURT2', $(at 18:00), $(at 19:00), '$T3');")
  check admin "S2b first call is new" "select '$H1' like '%/false';" t
  check admin "S2c retry returns the same hold, marked as a replay" "select '${H2%%/*}' = '${H1%%/*}' and '$H2' like '%/true';" t
  check admin "S2d one pending booking for that token, payment pending" "select count(*)||'/'||max(b.status::text)||'/'||max(p.status::text) from bookings b join payments p on p.booking_id=b.id where b.player_id='$U1' and b.client_token='$T3';" "1/pending/pending"
  fails_with $U1 "S2e same token, different court: refused" "select hold_slot('$CLUB','$COURT', $(at 18:00), $(at 19:00), '$T3');" token_reused
  check $U2 "S2f the website's 4-argument call still works (no token)" "select (select count(*) from hold_slot('$CLUB','$COURT', $(at 20:00), $(at 21:00)));" 1
  check $U2 "S2g ...named-argument form too, which replaces that player's earlier hold as before" "select (select count(*) from hold_slot(p_club => '$CLUB', p_court => '$COURT', p_start => $(at 21:00), p_end => $(at 22:00)));" 1
  check admin "S2g2 ...one pending hold for that player (the earlier one expired)" "select count(*) from bookings where player_id='$U2' and status='pending';" 1
  check admin "S2h the website's holds carry no token" "select count(*) from bookings where player_id='$U2' and client_token is not null and status='pending';" 0
  holdr() { { as $U1; echo "begin; select booking_id from hold_slot('$CLUB','$COURT2', $(at 15:00), $(at 16:00), '$1'); select pg_sleep(1); commit;"; } | psql "$DB" -At 2>&1; }
  T4=$(q admin "select gen_random_uuid()")
  holdr "$T4" > /tmp/s2a.log & sleep 0.3; holdr "$T4" > /tmp/s2b.log & wait
  R1=$(grep -m1 -E '^[0-9a-f-]{36}$' /tmp/s2a.log); R2=$(grep -m1 -E '^[0-9a-f-]{36}$' /tmp/s2b.log)
  CHECKS=$((CHECKS+1)); if [ -n "$R1" ] && [ "$R1" = "$R2" ]; then echo "  ok    S2i two simultaneous calls with one token: the same booking"; else echo "  FAIL  S2i"; cat /tmp/s2a.log /tmp/s2b.log; FAILS=$((FAILS+1)); fi
  check admin "S2j ...and one row" "select count(*) from bookings where player_id='$U1' and client_token='$T4';" 1
else
  echo "  (hold_slot has no retry token yet — 0065 not applied; S2b–S2j skipped)"
fi

echo "--- S3. staff moves keep the club's minimum and maximum length (migration 0066) and the slot rules"
HAS_0066=$(q admin "select (prosrc like '%min_booking_minutes%')::text from pg_proc where proname='move_booking' and pronamespace='public'::regnamespace")
$PSQL -q -c "update clubs set payment_mode='at_desk', min_booking_minutes = 60 where id='$CLUB'; insert into club_staff (club_id, profile_id) values ('$CLUB', '$U1') on conflict do nothing;" >/dev/null
check admin "S3a club limits for this test: 30 min grid, 1 h minimum, 3 h maximum, 08:00-23:00" "select slot_minutes||'/'||min_booking_minutes||'/'||max_booking_minutes||'/'||to_char(open_time,'HH24:MI')||'-'||to_char(close_time,'HH24:MI') from clubs where id='$CLUB';" "30/60/180/08:00-23:00"
MB=$(q $U1 "select staff_book('$CLUB','$COURT3', $(at 09:00), $(at 10:00), 'smoke-move', null);")
check admin "S3b fixture: a 1 h walk-in booked by staff" "select count(*) from bookings where id='$MB' and status='confirmed' and source='staff';" 1
mv() { q $U1 "select move_booking('$MB','$1', $(at $2), $(at $3))::text || 'moved';"; }
span() { q admin "select to_char(start_at at time zone 'Asia/Beirut','HH24:MI')||'-'||to_char(end_at at time zone 'Asia/Beirut','HH24:MI') from bookings where id='$MB';"; }
if [ "$HAS_0066" = "true" ]; then
  fails_with $U1 "S3c move to 30 min (below the 1 h minimum): refused" "select move_booking('$MB','$COURT3', $(at 09:00), $(at 09:30));" bad_duration
  fails_with $U1 "S3d move to 4 h (above the 3 h maximum): refused" "select move_booking('$MB','$COURT3', $(at 09:00), $(at 13:00));" bad_duration
  fails_with $U1 "S3e move to 3 h 30 elsewhere (above the maximum): refused" "select move_booking('$MB','$COURT2', $(at 12:00), $(at 15:30));" bad_duration
  check admin "S3f ...the booking is unchanged" "select '$(span)';" "09:00-10:00"
  check $U1 "S3g move to 1 h 30 at another time (within limits): accepted" "select move_booking('$MB','$COURT3', $(at 11:00), $(at 12:30))::text || 'moved';" moved
  check $U1 "S3h move to exactly 3 h (the maximum): accepted" "select move_booking('$MB','$COURT3', $(at 11:00), $(at 14:00))::text || 'moved';" moved
  check $U1 "S3i move to exactly 1 h (the minimum): accepted" "select move_booking('$MB','$COURT3', $(at 11:00), $(at 12:00))::text || 'moved';" moved
  $PSQL -q -c "update clubs set min_booking_minutes = 120 where id='$CLUB';" >/dev/null
  check $U1 "S3j club raises its minimum to 2 h: the 1 h booking can still move at its existing length" "select move_booking('$MB','$COURT2', $(at 16:30), $(at 17:30))::text || 'moved';" moved
  fails_with $U1 "S3k ...but not to another length below the new minimum (1 h 30)" "select move_booking('$MB','$COURT2', $(at 16:30), $(at 18:00));" bad_duration
  $PSQL -q -c "update clubs set min_booking_minutes = 60 where id='$CLUB';" >/dev/null
else
  echo "  (move_booking has no length check yet — 0066 not applied; S3c-S3k skipped)"
fi
fails_with $U1 "S3l off the 30-minute grid (10:10): refused by the slot trigger" "select move_booking('$MB','$COURT2', $(at 10:10), $(at 11:10));" not_on_grid
fails_with $U1 "S3m before opening (06:00): refused" "select move_booking('$MB','$COURT2', $(at 06:00), $(at 07:00));" outside_opening_hours
fails_with $U1 "S3n not whole slots (1 h 15): refused" "select move_booking('$MB','$COURT2', $(at 10:00), $(at 11:15));" bad_duration
OB=$(q $U1 "select staff_book('$CLUB','$COURT2', $(at 19:00), $(at 20:00), 'smoke-move', null);")
fails_with $U1 "S3o onto another booking: refused" "select move_booking('$MB','$COURT2', $(at 19:30), $(at 20:30));" slot_taken
fails_with $U2 "S3p a player who is not staff cannot move it" "select move_booking('$MB','$COURT2', $(at 21:00), $(at 22:00));" forbidden

echo
echo "checks: $CHECKS, failures: $FAILS"
[ "$FAILS" = 0 ] && echo "STAGING SMOKE OK"
exit $([ "$FAILS" = 0 ] && echo 0 || echo 1)
