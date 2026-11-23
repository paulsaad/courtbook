#!/usr/bin/env bash
# Cancellation and refunds (cancel_booking after 0083), checked on the real staging database.
#   DB=<staging connection string> bash supabase/tests/staging_cancel.sh
# Disposable fixtures only: three throwaway accounts and two temporary courts in the demo club (zz-cancel-1/2).
# Existing bookings, blocks and club settings are never touched, except the demo club's payment mode, which is
# switched for the test and put back. Everything is removed at the end, on failure and on cancellation.
# Uses today's clock (bookings "in progress" and "inside the cutoff"): runs between 08:00 and 20:00 Beirut.
set -u
: "${DB:?set DB}"
case "$DB" in *lgujfbwunokobjxlvpuf*) echo "refusing: this is the LIVE project"; exit 1;; esac
PSQL="psql $DB -v ON_ERROR_STOP=1"
U1=5a0e0002-0000-4000-8000-000000000001   # player
U2=5a0e0002-0000-4000-8000-000000000002   # another player
U3=5a0e0002-0000-4000-8000-000000000003   # club staff
FAILS=0; CHECKS=0
as() { echo "set role authenticated; set request.jwt.claim.sub = '$1'; set request.jwt.claim.role = 'authenticated';"; }
q() { local out e; out=$({ echo "\\set QUIET on"; [ "$1" = admin ] || { [ "$1" = server ] && echo "set role service_role; set request.jwt.claim.role = 'service_role';"; } || as "$1"; echo "$2"; } | psql "$DB" -At 2>&1 | grep -v '^$')
  e=$(echo "$out" | grep -m1 ERROR); if [ -n "$e" ]; then echo "$e"; else echo "$out" | tail -1; fi; }
check() { CHECKS=$((CHECKS+1)); local got; got=$(q "$1" "$3"); if [ "$got" == "$4" ]; then echo "  ok    $2"; else echo "  FAIL  $2 — expected [$4] got [$got]"; FAILS=$((FAILS+1)); fi; }
fails_with() { CHECKS=$((CHECKS+1)); local got; got=$(q "$1" "$3"); if echo "$got" | grep -q "$4"; then echo "  ok    $2 ($4)"; else echo "  FAIL  $2 — expected an error containing [$4], got [$got]"; FAILS=$((FAILS+1)); fi; }
notrun() { CHECKS=$((CHECKS+1)); FAILS=$((FAILS+1)); echo "  FAIL  $1 not run: $2 (not a verification)"; }

CLUB=$(q admin "select id from clubs where slug='batroun'")
[ -n "$CLUB" ] || { echo "demo club missing"; exit 1; }
MODE=$(q admin "select payment_mode from clubs where id='$CLUB'")
CUTOFF=$(q admin "select cancel_cutoff_hours from clubs where id='$CLUB'")
TESTCOURTS="(select id from courts where club_id = '$CLUB' and name like 'zz-cancel-%')"
USERS="('$U1','$U2','$U3')"
cleanup() {
  { echo "\\set QUIET on"; cat <<SQL
delete from credit_transactions where booking_id in (select id from bookings where court_id in $TESTCOURTS) or profile_id in $USERS;
delete from payments where booking_id in (select id from bookings where court_id in $TESTCOURTS or player_id in $USERS or created_by in $USERS);
delete from bookings where court_id in $TESTCOURTS or player_id in $USERS or created_by in $USERS;
delete from courts where id in $TESTCOURTS;
delete from club_staff where profile_id in $USERS;
delete from auth.users where id in $USERS;
update clubs set payment_mode = '$MODE' where id = '$CLUB';
SQL
  } | psql "$DB" -v ON_ERROR_STOP=1 -q >/dev/null
}
cleanup
trap cleanup EXIT
trap 'exit 130' INT TERM
$PSQL -q -c "insert into auth.users (id, email, aud, role) values ('$U1','cancel1@courtbook.test','authenticated','authenticated'), ('$U2','cancel2@courtbook.test','authenticated','authenticated'), ('$U3','cancel3@courtbook.test','authenticated','authenticated');" >/dev/null || { echo "could not create test users"; exit 1; }
$PSQL -q -c "insert into courts (club_id, name, sport, surface, sort) values ('$CLUB','zz-cancel-1','padel','test',921), ('$CLUB','zz-cancel-2','padel','test',922);" >/dev/null || { echo "could not create test courts"; exit 1; }
$PSQL -q -c "insert into club_staff (club_id, profile_id) values ('$CLUB','$U3');" >/dev/null || { echo "could not add test staff"; exit 1; }
C1=$(q admin "select id from courts where club_id='$CLUB' and name='zz-cancel-1'")
C2=$(q admin "select id from courts where club_id='$CLUB' and name='zz-cancel-2'")
echo "test courts zz-cancel-1/2 (temporary); demo club cutoff: $CUTOFF h; payment mode $MODE (put back at the end)"

at() { echo "((current_date + $1 + time '$2') at time zone 'Asia/Beirut')"; }               # day offset, Beirut time
t() { echo "(date_bin('30 minutes', now(), '2000-01-01') + interval '$1 minutes')"; }           # relative to now, on the grid
# a paid in-app booking: hold, then the server confirms the (simulated) payment, as the payment route does
paid() { local id pay tot; id=$(q "$1" "select booking_id from hold_slot('$CLUB','$2', $3, $4, gen_random_uuid());")
  pay=$(q admin "select id from payments where booking_id='$id'"); tot=$(q admin "select total_usd from payments where id='$pay'")
  q server "select confirm_payment('$pay', 'cancel-test-' || gen_random_uuid(), $tot);" >/dev/null; echo "$id"; }
st() { q admin "select b.status || '/' || coalesce(string_agg(p.status::text || ':' || coalesce(p.note, '-'), ',' order by p.created_at), 'none') from bookings b left join payments p on p.booking_id = b.id where b.id = '$1' group by b.status;"; }

$PSQL -q -c "update clubs set payment_mode = 'simulated' where id = '$CLUB';" >/dev/null

echo "--- K. a player cancels a future booking, before the cutoff (refund due)"
F1=$(paid $U1 "$C1" "$(at 3 10:00)" "$(at 3 11:00)")
check admin "K0 fixture: paid future booking" "select status from bookings where id='$F1';" confirmed
fails_with $U2 "K1 another player cannot cancel it" "select cancel_booking('$F1');" forbidden
fails_with $U1 "K2 a player cannot call it club-caused" "select cancel_booking('$F1', true);" forbidden
check admin "K3 ...still confirmed and paid" "select '$(st "$F1")';" "confirmed/paid:-"
check $U1 "K4 the player cancels" "select cancel_booking('$F1')::text || 'done';" done
check admin "K5 cancelled; payment refund_due (cancelled before cutoff)" "select '$(st "$F1")';" "cancelled/refund_due:cancelled before cutoff"
fails_with $U1 "K6 cancelling again: not_confirmed" "select cancel_booking('$F1');" not_confirmed
check admin "K7 ...still one payment, still refund_due; no credit moved" "select '$(st "$F1")|' || (select count(*) from credit_transactions where booking_id='$F1');" "cancelled/refund_due:cancelled before cutoff|0"

echo "--- L. inside the cutoff, and bookings that have started (today's clock)"
WIN=$(q admin "select (to_char(now() at time zone 'Asia/Beirut', 'HH24:MI') between '08:00' and '20:00')::text")
INSIDE=$(q admin "select ($(t 90) > now() and $(t 90) - make_interval(hours => $CUTOFF) < now())::text")
if [ "$WIN" != true ]; then notrun "L" "needs 08:00–20:00 Beirut"
elif [ "$INSIDE" != true ]; then notrun "L1–L3" "the club cutoff ($CUTOFF h) is too short for a booking 1 h 30 ahead"
else
  F2=$(paid $U1 "$C1" "$(t 90)" "$(t 150)")
  check admin "L0 fixture: paid booking starting in 1 h 30, inside the $CUTOFF h cutoff" "select '$(st "$F2")';" "confirmed/paid:-"
  check $U1 "L1 the player can still cancel it (it has not started)" "select cancel_booking('$F2')::text || 'done';" done
  check admin "L2 cancelled; payment stays paid, no refund (inside the cutoff)" "select '$(st "$F2")';" "cancelled/paid:-"
  check admin "L3 ...no refund credit" "select count(*) from credit_transactions where booking_id='$F2';" 0
fi
if [ "$WIN" = true ]; then
  # a player's booking that is being played: created as it would have been an hour ago (fixture rows; the booking
  # functions refuse a start in the past, by design)
  mk_started() { local id; id=$(q admin "insert into bookings (club_id, court_id, player_id, start_at, end_at, status, source, created_by, price_usd) values ('$CLUB','$1','$U1', $(t -30), $(t 30), 'confirmed', 'app', '$U1', 20) returning id;")
    q admin "insert into payments (booking_id, profile_id, club_id, provider, provider_ref, amount_usd, fee_usd, total_usd, status, paid_at) values ('$id','$U1','$CLUB','simulated','cancel-test-' || gen_random_uuid(), 20, 0, 20, 'paid', now() - interval '1 hour');" >/dev/null; echo "$id"; }
  F3=$(mk_started "$C2")
  check admin "L4 fixture: the player's paid booking started 30 min ago" "select '$(st "$F3")';" "confirmed/paid:-"
  fails_with $U1 "L5 the player cannot cancel a booking that has started" "select cancel_booking('$F3');" booking_started
  check admin "L6 ...unchanged: confirmed and paid" "select '$(st "$F3")';" "confirmed/paid:-"
  check $U3 "L7 club staff can cancel it (correcting the record)" "select cancel_booking('$F3')::text || 'done';" done
  check admin "L8 cancelled by staff, not club-caused: no refund (past the cutoff)" "select '$(st "$F3")';" "cancelled/paid:-"
  F4=$(mk_started "$C2")
  check $U3 "L9 staff cancel a started booking as the club's fault" "select cancel_booking('$F4', true)::text || 'done';" done
  check admin "L10 ...refund_due (club-caused cancellation)" "select '$(st "$F4")';" "cancelled/refund_due:club-caused cancellation"
  fails_with $U2 "L11 a player who is not staff cannot cancel someone's started booking" "select cancel_booking('$(mk_started "$C1")');" forbidden
fi

echo "--- H. holds and pay-at-the-club bookings"
H1=$(q $U1 "select booking_id from hold_slot('$CLUB','$C1', $(at 3 12:00), $(at 3 13:00), gen_random_uuid());")
check $U1 "H1 the player releases their unpaid hold" "select cancel_booking('$H1')::text || 'done';" done
check admin "H2 hold cancelled; payment expired (nothing was paid, nothing due)" "select '$(st "$H1")';" "cancelled/expired:-"
$PSQL -q -c "update clubs set payment_mode = 'at_desk' where id = '$CLUB';" >/dev/null
D1=$(q $U1 "select booking_id from book_at_desk('$C1', $(at 3 14:00), $(at 3 15:00), gen_random_uuid());")
D1S=$(st "$D1")
check $U1 "H3 the player cancels a pay-at-the-club booking before the cutoff" "select cancel_booking('$D1')::text || 'done';" done
check admin "H4 cancelled; nothing was paid through CourtBook, so no refund is due" "select (b.status = 'cancelled' and not exists (select 1 from payments p where p.booking_id = b.id and p.status in ('paid','refund_due','refunded')))::text from bookings b where b.id='$D1';" true
echo "        (pay-at-the-club booking before: $D1S; after: $(st "$D1"))"
$PSQL -q -c "update clubs set payment_mode = 'simulated' where id = '$CLUB';" >/dev/null

echo "--- R. at the same moment"
F5=$(paid $U1 "$C2" "$(at 4 10:00)" "$(at 4 11:00)")
r=$( { for i in 1 2 3; do { as $U1; echo "select cancel_booking('$F5'); select 'ok';"; } | psql "$DB" -At 2>&1 | grep -m1 -oE "^ok$|not_confirmed|ERROR.*" | sed 's/^ERROR: *//' & done; wait; } | sort | tr '\n' ',')
CHECKS=$((CHECKS+1)); if [ "$r" = "not_confirmed,not_confirmed,ok," ]; then echo "  ok    R1 three simultaneous cancels by the player: one succeeds, two not_confirmed"; else echo "  FAIL  R1 three simultaneous cancels — got [$r]"; FAILS=$((FAILS+1)); fi
check admin "R2 ...one payment, refund_due once" "select '$(st "$F5")';" "cancelled/refund_due:cancelled before cutoff"
H2=$(q $U1 "select booking_id from hold_slot('$CLUB','$C2', $(at 4 12:00), $(at 4 13:00), gen_random_uuid());")
P2=$(q admin "select id from payments where booking_id='$H2'"); T2=$(q admin "select total_usd from payments where id='$P2'")
{ { as $U1; echo "select cancel_booking('$H2');"; } | psql "$DB" -At >/dev/null 2>&1 & { echo "set role service_role; set request.jwt.claim.role = 'service_role';"; echo "select confirm_payment('$P2', 'cancel-test-' || gen_random_uuid(), $T2);"; } | psql "$DB" -At >/dev/null 2>&1 & wait; }
R3=$(st "$H2")
CHECKS=$((CHECKS+1)); # valid ends: cancel first and the payment never landed (expired); payment first, then cancel (refund due before the
# cutoff); cancel first, then the payment landed (recorded as refund due). Never a cancelled booking with money kept.
case "$R3" in "cancelled/expired:-"|"cancelled/refund_due:cancelled before cutoff"|"cancelled/refund_due:paid after hold expired or booking cancelled") echo "  ok    R3 the player cancels a hold while its payment is confirmed: a consistent end state ($R3)";; *) echo "  FAIL  R3 cancel racing the payment confirmation: inconsistent [$R3]"; FAILS=$((FAILS+1));; esac

echo "--- I. consistency of everything this test made"
check admin "I1 no cancelled booking with a pending payment; no confirmed booking with an unpaid in-app payment; refund_due only on cancelled bookings; at most one payment per booking" "select count(*) from bookings b join payments p on p.booking_id = b.id where b.court_id in $TESTCOURTS and ((b.status = 'cancelled' and p.status = 'pending') or (b.status = 'confirmed' and p.provider = 'simulated' and p.status <> 'paid') or (p.status = 'refund_due' and b.status <> 'cancelled')) or (b.court_id in $TESTCOURTS and (select count(*) from payments x where x.booking_id = b.id) > 1);" 0
check admin "I2 no refund credits were created (no booking here used credits)" "select count(*) from credit_transactions where booking_id in (select id from bookings where court_id in $TESTCOURTS);" 0

echo "--- Z. clean-up"
trap - EXIT
cleanup
check admin "Z1 clean-up: no test accounts, test courts or their bookings/payments left; payment mode restored" "select ((select count(*) from auth.users where id in $USERS) + (select count(*) from courts where club_id='$CLUB' and name like 'zz-cancel-%') + (select count(*) from bookings where player_id in $USERS or created_by in $USERS) = 0 and (select payment_mode::text from clubs where id='$CLUB') = '$MODE')::text;" true
echo
echo "checks: $CHECKS, failures: $FAILS"
[ "$FAILS" = 0 ] && echo "STAGING CANCEL OK"
exit $([ "$FAILS" = 0 ] && echo 0 || echo 1)
