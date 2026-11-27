#!/usr/bin/env bash
# Booking protections, checked on the real staging database (Supabase, through the pooler) rather
# than the local shim. Usage: DB=<staging connection string> bash supabase/tests/staging_smoke.sh
#
# Two throwaway players are created, everything they make is deleted at the end (and at the start,
# in case an earlier run stopped half-way), and the demo club's payment mode is put back. It refuses
# the live project. Section S2 runs only if hold_slot takes a retry token (migration 0065). Section S4
# (release fix 0071) uses today's clock, so it runs only between 11:00 and 22:00 Beirut.
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
MODE=$(q admin "select payment_mode from clubs where id='$CLUB'")
MINB=$(q admin "select min_booking_minutes from clubs where id='$CLUB'")
[ -n "$CLUB" ] || { echo "demo club missing"; exit 1; }
at() { echo "((current_date + 2 + time '$1') at time zone 'Asia/Beirut')"; }

# the test's own courts (padel, the club's hours and club-wide prices): existing bookings and calendar blocks are never touched
TESTCOURTS="(select id from courts where club_id = '$CLUB' and name like 'zz-smoke-%')"
cleanup() {
  { echo "\\set QUIET on"; cat <<SQL
delete from payments where booking_id in (select id from bookings where player_id in ('$U1','$U2') or created_by in ('$U1','$U2') or court_id in $TESTCOURTS);
delete from bookings where player_id in ('$U1','$U2') or created_by in ('$U1','$U2') or court_id in $TESTCOURTS;
delete from blocks where court_id in $TESTCOURTS;
delete from courts where id in $TESTCOURTS;
delete from club_staff where profile_id in ('$U1','$U2');
delete from auth.users where id in ('$U1','$U2');
update clubs set payment_mode = '$MODE', min_booking_minutes = $MINB where id = '$CLUB';
SQL
  } | psql "$DB" -v ON_ERROR_STOP=1 -q >/dev/null
}
cleanup
trap cleanup EXIT
trap 'exit 130' INT TERM   # a cancelled job still runs the clean-up
$PSQL -q -c "insert into auth.users (id, email, aud, role) values ('$U1','smoke1@courtbook.test','authenticated','authenticated'), ('$U2','smoke2@courtbook.test','authenticated','authenticated');" >/dev/null || { echo "could not create test users"; exit 1; }
$PSQL -q -c "insert into courts (club_id, name, sport, surface, sort) values ('$CLUB','zz-smoke-1','padel','test',901), ('$CLUB','zz-smoke-2','padel','test',902), ('$CLUB','zz-smoke-3','padel','test',903);" >/dev/null || { echo "could not create test courts"; exit 1; }
COURT=$(q admin "select id from courts where club_id='$CLUB' and name='zz-smoke-1'")
COURT2=$(q admin "select id from courts where club_id='$CLUB' and name='zz-smoke-2'")
COURT3=$(q admin "select id from courts where club_id='$CLUB' and name='zz-smoke-3'")
echo "test courts: zz-smoke-1..3 (temporary, removed at the end)"

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
# the length rules (0066) live in the move function the desk calls: since F1, the 8-argument move_booking_priced
HAS_0066=$(q admin "select coalesce(bool_or(prosrc like '%min_booking_minutes%'), false)::text from pg_proc where proname in ('move_booking','move_booking_priced') and pronamespace='public'::regnamespace")
$PSQL -q -c "update clubs set payment_mode='at_desk', min_booking_minutes = 60 where id='$CLUB'; insert into club_staff (club_id, profile_id) values ('$CLUB', '$U1') on conflict do nothing;" >/dev/null
check admin "S3a club limits for this test: 30 min grid, 1 h minimum, 3 h maximum, 08:00-23:00" "select slot_minutes||'/'||min_booking_minutes||'/'||max_booking_minutes||'/'||to_char(open_time,'HH24:MI')||'-'||to_char(close_time,'HH24:MI') from clubs where id='$CLUB';" "30/60/180/08:00-23:00"
MB=$(q $U1 "select staff_book('$CLUB','$COURT3', $(at 09:00), $(at 10:00), 'smoke-move', null);")
check admin "S3b fixture: a 1 h walk-in booked by staff" "select count(*) from bookings where id='$MB' and status='confirmed' and source='staff';" 1
mv() { q $U1 "select (case when move_booking_priced('$MB','$1', $(at $2), $(at $3), quote_price('$1', $(at $2), $(at $3)), (select court_id from bookings where id = '$MB'), (select start_at from bookings where id = '$MB'), (select end_at from bookings where id = '$MB')) is not null then ''::text end)::text || 'moved';"; }
span() { q admin "select to_char(start_at at time zone 'Asia/Beirut','HH24:MI')||'-'||to_char(end_at at time zone 'Asia/Beirut','HH24:MI') from bookings where id='$MB';"; }
if [ "$HAS_0066" = "true" ]; then
  fails_with $U1 "S3c move to 30 min (below the 1 h minimum): refused" "select (case when move_booking_priced('$MB','$COURT3', $(at 09:00), $(at 09:30), quote_price('$COURT3', $(at 09:00), $(at 09:30)), (select court_id from bookings where id = '$MB'), (select start_at from bookings where id = '$MB'), (select end_at from bookings where id = '$MB')) is not null then ''::text end);" bad_duration
  # refusals the quote would give first (0092: too_long; before opening: no price) pass a constant price (0) instead,
  # so the MOVE function answers; it refuses the length before it compares the price (review R106-2)
  fails_with $U1 "S3d move to 4 h (above the 3 h maximum): refused" "select (case when move_booking_priced('$MB','$COURT3', $(at 09:00), $(at 13:00), 0, (select court_id from bookings where id = '$MB'), (select start_at from bookings where id = '$MB'), (select end_at from bookings where id = '$MB')) is not null then ''::text end);" bad_duration
  fails_with $U1 "S3e move to 3 h 30 elsewhere (above the maximum): refused" "select (case when move_booking_priced('$MB','$COURT2', $(at 12:00), $(at 15:30), 0, (select court_id from bookings where id = '$MB'), (select start_at from bookings where id = '$MB'), (select end_at from bookings where id = '$MB')) is not null then ''::text end);" bad_duration
  check admin "S3f ...the booking is unchanged" "select '$(span)';" "09:00-10:00"
  check $U1 "S3g move to 1 h 30 at another time (within limits): accepted" "select (case when move_booking_priced('$MB','$COURT3', $(at 11:00), $(at 12:30), quote_price('$COURT3', $(at 11:00), $(at 12:30)), (select court_id from bookings where id = '$MB'), (select start_at from bookings where id = '$MB'), (select end_at from bookings where id = '$MB')) is not null then ''::text end)::text || 'moved';" moved
  check $U1 "S3h move to exactly 3 h (the maximum): accepted" "select (case when move_booking_priced('$MB','$COURT3', $(at 11:00), $(at 14:00), quote_price('$COURT3', $(at 11:00), $(at 14:00)), (select court_id from bookings where id = '$MB'), (select start_at from bookings where id = '$MB'), (select end_at from bookings where id = '$MB')) is not null then ''::text end)::text || 'moved';" moved
  check $U1 "S3i move to exactly 1 h (the minimum): accepted" "select (case when move_booking_priced('$MB','$COURT3', $(at 11:00), $(at 12:00), quote_price('$COURT3', $(at 11:00), $(at 12:00)), (select court_id from bookings where id = '$MB'), (select start_at from bookings where id = '$MB'), (select end_at from bookings where id = '$MB')) is not null then ''::text end)::text || 'moved';" moved
  $PSQL -q -c "update clubs set min_booking_minutes = 120 where id='$CLUB';" >/dev/null
  check $U1 "S3j club raises its minimum to 2 h: the 1 h booking can still move at its existing length" "select (case when move_booking_priced('$MB','$COURT2', $(at 16:30), $(at 17:30), quote_price('$COURT2', $(at 16:30), $(at 17:30)), (select court_id from bookings where id = '$MB'), (select start_at from bookings where id = '$MB'), (select end_at from bookings where id = '$MB')) is not null then ''::text end)::text || 'moved';" moved
  fails_with $U1 "S3k ...but not to another length below the new minimum (1 h 30)" "select (case when move_booking_priced('$MB','$COURT2', $(at 16:30), $(at 18:00), quote_price('$COURT2', $(at 16:30), $(at 18:00)), (select court_id from bookings where id = '$MB'), (select start_at from bookings where id = '$MB'), (select end_at from bookings where id = '$MB')) is not null then ''::text end);" bad_duration
  $PSQL -q -c "update clubs set min_booking_minutes = 60 where id='$CLUB';" >/dev/null
else
  echo "  (move_booking has no length check yet — 0066 not applied; showing the gap it closes)"
  check $U1 "S3c-gap without 0066: moving it to 30 min (below the 1 h minimum) is ACCEPTED" "select (case when move_booking_priced('$MB','$COURT3', $(at 09:00), $(at 09:30), quote_price('$COURT3', $(at 09:00), $(at 09:30)), (select court_id from bookings where id = '$MB'), (select start_at from bookings where id = '$MB'), (select end_at from bookings where id = '$MB')) is not null then ''::text end)::text || 'moved';" moved
  check $U1 "S3d-gap without 0066: moving it to 4 h (above the 3 h maximum) is ACCEPTED" "select (case when move_booking_priced('$MB','$COURT3', $(at 09:00), $(at 13:00), quote_price('$COURT3', $(at 09:00), $(at 13:00)), (select court_id from bookings where id = '$MB'), (select start_at from bookings where id = '$MB'), (select end_at from bookings where id = '$MB')) is not null then ''::text end)::text || 'moved';" moved
  q $U1 "select (case when move_booking_priced('$MB','$COURT3', $(at 09:00), $(at 10:00), quote_price('$COURT3', $(at 09:00), $(at 10:00)), (select court_id from bookings where id = '$MB'), (select start_at from bookings where id = '$MB'), (select end_at from bookings where id = '$MB')) is not null then ''::text end);" >/dev/null
fi
fails_with $U1 "S3l off the 30-minute grid (10:10): refused by the slot trigger" "select (case when move_booking_priced('$MB','$COURT2', $(at 10:10), $(at 11:10), quote_price('$COURT2', $(at 10:10), $(at 11:10)), (select court_id from bookings where id = '$MB'), (select start_at from bookings where id = '$MB'), (select end_at from bookings where id = '$MB')) is not null then ''::text end);" not_on_grid
# since 0092 a time with no price is refused first (no_price_rule); before 0092 the hours check answered
# the move function must answer, not the quote (review R106-2): the desk's price is the quote where the club has a
# price for 06:00, else a constant 0 (the quote itself would refuse no_price_rule). With no price the move function
# refuses no_price_rule while pricing the new time; with one, its price check passes and the slot trigger refuses
# outside_opening_hours. Either way the refusal comes from the move function.
fails_with $U1 "S3m before opening (06:00): refused" "do \$m\$ declare p numeric; begin
  begin p := quote_price('$COURT2', $(at 06:00), $(at 07:00)); exception when others then p := 0; end;
  perform move_booking_priced('$MB','$COURT2', $(at 06:00), $(at 07:00), p, b.court_id, b.start_at, b.end_at) from bookings b where b.id = '$MB';
end \$m\$;" "no_price_rule\|outside_opening_hours"
fails_with $U1 "S3n not whole slots (1 h 15): refused" "select (case when move_booking_priced('$MB','$COURT2', $(at 10:00), $(at 11:15), quote_price('$COURT2', $(at 10:00), $(at 11:15)), (select court_id from bookings where id = '$MB'), (select start_at from bookings where id = '$MB'), (select end_at from bookings where id = '$MB')) is not null then ''::text end);" bad_duration
OB=$(q $U1 "select staff_book('$CLUB','$COURT2', $(at 19:00), $(at 20:00), 'smoke-move', null);")
fails_with $U1 "S3o onto another booking: refused" "select (case when move_booking_priced('$MB','$COURT2', $(at 19:30), $(at 20:30), quote_price('$COURT2', $(at 19:30), $(at 20:30)), (select court_id from bookings where id = '$MB'), (select start_at from bookings where id = '$MB'), (select end_at from bookings where id = '$MB')) is not null then ''::text end);" slot_taken
fails_with $U2 "S3p a player who is not staff cannot move it" "select (case when move_booking_priced('$MB','$COURT2', $(at 21:00), $(at 22:00), quote_price('$COURT2', $(at 21:00), $(at 22:00)), (select court_id from bookings where id = '$MB'), (select start_at from bookings where id = '$MB'), (select end_at from bookings where id = '$MB')) is not null then ''::text end);" forbidden

# the price rule (0091) and the reload rule (0099), stated explicitly: no move changes a price without confirming it,
# and a page from before 0099 (4- or 5-argument call) is told to reload. The booking is now 16:30-17:30 on court 2.
seen() { echo "(select court_id from bookings where id = '$MB'), (select start_at from bookings where id = '$MB'), (select end_at from bookings where id = '$MB')"; }
state() { q admin "select to_char(start_at at time zone 'Asia/Beirut','HH24:MI')||'-'||to_char(end_at at time zone 'Asia/Beirut','HH24:MI')||' '||price_usd::numeric(10,2) from bookings where id='$MB';"; }
S3BEFORE=$(state)
fails_with $U1 "S3q a move that would change the price, with no confirmed price: refused" "select move_booking_priced('$MB','$COURT2', $(at 20:00), $(at 21:00), null, $(seen));" price_confirmation_needed
fails_with $U1 "S3r a confirmed price that is not the database's: refused" "select move_booking_priced('$MB','$COURT2', $(at 20:00), $(at 21:00), 99, $(seen));" price_changed
fails_with $U1 "S3s a desk that saw an older court or time: refused" "select move_booking_priced('$MB','$COURT2', $(at 20:00), $(at 21:00), quote_price('$COURT2', $(at 20:00), $(at 21:00)), '$COURT3', $(at 09:00), $(at 10:00));" booking_changed_elsewhere
fails_with $U1 "S3t the pre-0099 4-argument call: refused" "select move_booking('$MB','$COURT2', $(at 20:00), $(at 21:00));" move_needs_reload
fails_with $U1 "S3t2 the pre-0099 5-argument call: refused" "select move_booking_priced('$MB','$COURT2', $(at 20:00), $(at 21:00), quote_price('$COURT2', $(at 20:00), $(at 21:00)));" move_needs_reload
check admin "S3u ...the booking is unchanged after every refusal (time and price)" "select '$(state)';" "$S3BEFORE"

echo "--- S4. staff and past times on today's real clock (release fix 0071): walk-in cutoff, extend, past, ended"
# Times are on the club's 30-minute grid relative to now (F = now rounded down to 30 min), on three courts.
HAS_0071=$(q admin "select (prosrc like '%walk_in_too_old%')::text from pg_proc where proname='staff_book' and pronamespace='public'::regnamespace")
FOK=$(q admin "select (to_char(date_bin('30 minutes', now(), '2000-01-01') at time zone 'Asia/Beirut', 'HH24:MI') between '11:00' and '21:30')::text")
t() { echo "(date_bin('30 minutes', now(), '2000-01-01') + interval '$1 minutes')"; }
BUSY=$(q admin "select (select count(*) from bookings where court_id in ('$COURT','$COURT2','$COURT3') and status in ('confirmed','pending') and tstzrange(start_at, end_at) && tstzrange($(t -180), $(t 90)) and coalesce(created_by::text,'') not in ('$U1','$U2')) + (select count(*) from blocks where court_id in ('$COURT','$COURT2','$COURT3') and period && tstzrange($(t -180), $(t 90)))")
S4NOTRUN() { CHECKS=$((CHECKS+1)); FAILS=$((FAILS+1)); echo "  FAIL  S4 not run: $1 (a skipped S4 is not a full verification)"; }
if [ "$HAS_0071" != "true" ]; then S4NOTRUN "0071 not applied"
elif [ "$FOK" != "true" ]; then S4NOTRUN "it needs the club's hours around now — run between 11:00 and 21:30 Beirut"
elif [ "$BUSY" != "0" ]; then S4NOTRUN "the test courts are not free around now ($BUSY items)"
else
  W1=$(q $U1 "select staff_book('$CLUB','$COURT', $(t -60), $(t 30), 'smoke-walkin', null);")
  check admin "S4a walk-in that started 60–89 min ago: accepted" "select status from bookings where id='$W1';" confirmed
  fails_with $U1 "S4b walk-in that started 3 h ago: refused" "select staff_book('$CLUB','$COURT2', $(t -180), $(t -120), 'smoke-walkin', null);" walk_in_too_old
  check $U1 "S4c extend the walk-in in progress by 30 min: accepted" "select (case when move_booking_priced('$W1','$COURT', $(t -60), $(t 60), quote_price('$COURT', $(t -60), $(t 60)), (select court_id from bookings where id = '$W1'), (select start_at from bookings where id = '$W1'), (select end_at from bookings where id = '$W1')) is not null then ''::text end)::text || 'moved';" moved
  fails_with $U1 "S4d move the walk-in in progress to start earlier: refused" "select (case when move_booking_priced('$W1','$COURT', $(t -90), $(t 60), quote_price('$COURT', $(t -90), $(t 60)), (select court_id from bookings where id = '$W1'), (select start_at from bookings where id = '$W1'), (select end_at from bookings where id = '$W1')) is not null then ''::text end);" move_into_past
  N=$(q $U1 "select staff_book('$CLUB','$COURT3', $(t 30), $(t 90), 'smoke-future', null);")
  fails_with $U1 "S4e move a booking that has not started into the past: refused" "select (case when move_booking_priced('$N','$COURT3', $(t -120), $(t -60), quote_price('$COURT3', $(t -120), $(t -60)), (select court_id from bookings where id = '$N'), (select start_at from bookings where id = '$N'), (select end_at from bookings where id = '$N')) is not null then ''::text end);" move_into_past
  E=$(q $U1 "select staff_book('$CLUB','$COURT2', $(t -90), $(t -30), 'smoke-ended', null);")
  check admin "S4f walk-in from 90–119 min ago lasting 1 h (already ended): accepted" "select (status = 'confirmed' and end_at < now())::text from bookings where id='$E';" true
  fails_with $U1 "S4g move the ended booking: refused" "select (case when move_booking_priced('$E','$COURT2', $(t 60), $(t 120), quote_price('$COURT2', $(t 60), $(t 120)), (select court_id from bookings where id = '$E'), (select start_at from bookings where id = '$E'), (select end_at from bookings where id = '$E')) is not null then ''::text end);" booking_ended
  check admin "S4h the refused moves changed nothing" "select (select to_char(start_at,'HH24:MI')||'-'||to_char(end_at,'HH24:MI') from bookings where id='$W1') = to_char($(t -60),'HH24:MI')||'-'||to_char($(t 60),'HH24:MI');" t
fi

echo "--- Z. clean-up"
trap - EXIT
cleanup
check admin "Z1 clean-up: no test users, test courts, or bookings/payments of either left; club settings restored" "select ((select count(*) from auth.users where id in ('$U1','$U2')) + (select count(*) from courts where club_id='$CLUB' and name like 'zz-smoke-%') + (select count(*) from bookings where player_id in ('$U1','$U2') or created_by in ('$U1','$U2')) = 0 and (select payment_mode::text = '$MODE' and min_booking_minutes = $MINB from clubs where id='$CLUB'))::text;" true
echo
echo "checks: $CHECKS, failures: $FAILS"
[ "$FAILS" = 0 ] && echo "STAGING SMOKE OK"
exit $([ "$FAILS" = 0 ] && echo 0 || echo 1)
