#!/usr/bin/env bash
# M2 (0079) under simultaneous sessions: account deletion racing against bookings, cancellations, moves and a second
# admin. Session A holds its transaction open for 2 s; session B starts 0.5 s in. Every race ends with the same
# invariant checks: no deadlock, no error, no upcoming or pending booking left for an anonymised owner, payments
# consistent with who cancelled first.
# LOCAL DISPOSABLE COPY ONLY: copies courtbook_test (built by run.sh from this checkout), drops the copy after.
#   PSQL="sudo -u postgres psql" bash supabase/tests/m2/deletion_races.sh
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
SRC=courtbook_test; DB=courtbook_m2_race
oks=0; fails=0
W=$(mktemp -d); chmod 755 "$W"; trap 'rm -rf "$W"' EXIT
rep() { if [ "$2" = true ]; then echo "ok    $1"; oks=$((oks+1)); else echo "FAIL  $1  [$3]"; fails=$((fails+1)); fi; }

P=e9000000-0000-4000-8000-000000000001     # the person deleting
S=e9000000-0000-4000-8000-000000000002     # staff of the demo club
A=e9000000-0000-4000-8000-000000000003     # admin
C1=e9000000-0000-4000-8000-000000000101; C2=e9000000-0000-4000-8000-000000000102; C3=e9000000-0000-4000-8000-000000000103
B1=e9000000-0000-4000-8000-000000000201; B2=e9000000-0000-4000-8000-000000000202
at() { echo "(((current_date + $1)::timestamp + (select open_time from clubs where slug = 'batroun') + interval '$2 hours') at time zone 'Asia/Beirut')"; }

setup() {
  $PSQL -q -d postgres -c "drop database if exists $DB" -c "create database $DB template $SRC" >/dev/null || exit 2
  $PSQL -X -q -d $DB -v ON_ERROR_STOP=1 >/dev/null <<SQL || { echo "cannot set up"; exit 2; }
insert into auth.users (id, phone) values ('$P', '+96179000001'), ('$S', '+96179000002'), ('$A', '+96179000003');
update profiles set name = 'Race person' where id = '$P';
update profiles set roles = '{player,admin}' where id = '$A';
update clubs set payment_mode = 'simulated', cancel_cutoff_hours = 6 where slug = 'batroun';
insert into club_staff (club_id, profile_id) select id, '$S' from clubs where slug = 'batroun';
insert into courts (id, club_id, name, sport, active, sort) select '$C1', id, 'Race 1', 'padel', true, 98 from clubs where slug = 'batroun';
insert into courts (id, club_id, name, sport, active, sort) select '$C2', id, 'Race 2', 'padel', true, 99 from clubs where slug = 'batroun';
insert into courts (id, club_id, name, sport, active, sort) select '$C3', id, 'Race 3', 'padel', true, 100 from clubs where slug = 'batroun';
insert into bookings (id, club_id, court_id, player_id, created_by, start_at, end_at, status, source, price_usd, fee_usd)
select '$B1', id, '$C1', '$P', '$P', $(at 5 2), $(at 5 2) + interval '60 min', 'confirmed', 'app', 20, 1 from clubs where slug = 'batroun';
insert into bookings (id, club_id, court_id, player_id, created_by, start_at, end_at, status, source, price_usd, fee_usd)
select '$B2', id, '$C2', '$P', '$P', $(at 6 2), $(at 6 2) + interval '60 min', 'confirmed', 'app', 20, 1 from clubs where slug = 'batroun';
insert into payments (booking_id, profile_id, club_id, provider, amount_usd, fee_usd, total_usd, status, paid_at)
select b.id, '$P', b.club_id, 'simulated', 20, 1, 21, 'paid', now() from bookings b where b.id in ('$B1', '$B2');
insert into account_deletions (subject_id, requested_via) values ('$P', 'web');
SQL
}
as_user() { echo "set local role authenticated; select set_config('request.jwt.claim.sub', '$1', true);"; }
race() {    # $1 user A, $2 statement A (held 2 s), $3 user B, $4 statement B
  ( $PSQL -X -q -d $DB -v ON_ERROR_STOP=1 >$W/a.out 2>&1 <<SQL
begin; $(as_user "$1") $2; select pg_sleep(2); commit;
SQL
    echo $? > $W/a.rc ) &
  sleep 0.5
  $PSQL -X -q -d $DB -v ON_ERROR_STOP=1 >$W/b.out 2>&1 <<SQL
begin; $(as_user "$3") $4; commit;
SQL
  echo $? > $W/b.rc; wait
}
q() { $PSQL -X -At -d $DB -c "$1"; }
DEL="select delete_account_data('$P')"
# the invariant every race must keep
ACTIVE_ANON="select count(*) from bookings where player_id is null and guest_name = 'Former player' and (status = 'pending' or (status = 'confirmed' and start_at > now()))"
LEFT_NAMED="select count(*) from bookings where player_id = '$P'"
nodead() { ! grep -qi "deadlock" $W/a.out $W/b.out; }
both_ok() { [ "$(cat $W/a.rc)" = 0 ] && [ "$(cat $W/b.rc)" = 0 ]; }
common() {  # $1 label
  rep "$1: no deadlock, both sessions succeed" "$(nodead && both_ok && echo true)" "A rc $(cat $W/a.rc): $(tail -1 $W/a.out | cut -c1-120) / B rc $(cat $W/b.rc): $(tail -1 $W/b.out | cut -c1-120)"
  rep "$1: no upcoming or pending booking left for an anonymised owner, none left under their name" \
      "$([ "$(q "$ACTIVE_ANON")" = 0 ] && [ "$(q "$LEFT_NAMED")" = 0 ] && echo true)" "active anon $(q "$ACTIVE_ANON"), named $(q "$LEFT_NAMED")"
}

echo "== RD1 two admins press Delete at the same time"
setup
race "$A" "$DEL" "$A" "$DEL"
common RD1
rep "RD1: the work was done once (2 bookings cancelled, 2 refunds due, one data_removed record)" \
    "$([ "$(q "select summary->>'bookings_cancelled' || '/' || (summary->'last_rerun'->>'bookings_cancelled') from account_deletions where subject_id = '$P'")" = "2/0" ] \
       && [ "$(q "select count(*) from payments where booking_id in ('$B1','$B2') and status = 'refund_due'")" = 2 ] \
       && [ "$(q "select count(*) from account_deletions where subject_id = '$P' and status = 'data_removed'")" = 1 ] && echo true)" \
    "$(q "select summary::text from account_deletions where subject_id = '$P'")"

echo "== RD2 staff cancel one booking (club-caused) while the deletion starts"
setup
race "$S" "select cancel_booking('$B2', true)" "$A" "$DEL"
common RD2
rep "RD2: the staff cancellation stands (club-caused refund); the deletion cancelled only the other booking" \
    "$([ "$(q "select note from payments where booking_id = '$B2'")" = "club-caused cancellation" ] \
       && [ "$(q "select summary->>'bookings_cancelled' from account_deletions where subject_id = '$P'")" = 1 ] && echo true)" \
    "$(q "select note from payments where booking_id = '$B2'") / $(q "select summary::text from account_deletions where subject_id = '$P'")"

echo "== RD3 staff move a booking from court 2 to court 1 while the deletion starts (two courts, opposite order)"
setup
race "$S" "select move_booking('$B2', '$C1', $(at 6 4), $(at 6 4) + interval '60 min')" "$A" "$DEL"
common RD3
rep "RD3: the moved booking was cancelled at its new place" \
    "$([ "$(q "select status || '@' || (court_id = '$C1') from bookings where id = '$B2'")" = "cancelled@true" ] && echo true)" \
    "$(q "select status || ' ' || court_id from bookings where id = '$B2'")"

echo "== RD4 the person's own hold is being written (request not yet open) while the deletion runs"
setup
q "update account_deletions set status = 'cancelled', cancelled_at = now() where subject_id = '$P'" >/dev/null
race "$P" "select hold_slot((select id from clubs where slug = 'batroun'), '$C1', $(at 7 2), $(at 7 2) + interval '60 min', gen_random_uuid())" \
     "$A" "select admin_record_deletion_request('$P'); $DEL"
common RD4
rep "RD4: the new hold was cancelled with the rest (3 cancelled)" \
    "$([ "$(q "select coalesce(summary->>'bookings_cancelled', '') from account_deletions where subject_id = '$P' and status = 'data_removed'")" = 3 ] && echo true)" \
    "$(q "select summary::text from account_deletions where subject_id = '$P' and status = 'data_removed'")"

echo "== RD5 the person cancels their own booking while the deletion starts"
setup
race "$P" "select cancel_booking('$B1')" "$A" "$DEL"
common RD5
rep "RD5: their own cancellation stands with the normal refund; the deletion cancelled the other" \
    "$([ "$(q "select status from payments where booking_id = '$B1'")" = refund_due ] \
       && [ "$(q "select summary->>'bookings_cancelled' from account_deletions where subject_id = '$P'")" = 1 ] && echo true)" \
    "$(q "select status || ' ' || coalesce(note, '') from payments where booking_id = '$B1'")"

echo "== RD6 the person's hold on a court none of their bookings use (outside the deletion's court locks) is being written"
setup
q "update account_deletions set status = 'cancelled', cancelled_at = now() where subject_id = '$P'" >/dev/null
race "$P" "select hold_slot((select id from clubs where slug = 'batroun'), '$C3', $(at 7 4), $(at 7 4) + interval '60 min', gen_random_uuid())" \
     "$A" "select admin_record_deletion_request('$P'); $DEL"
common RD6
rep "RD6: the new hold was cancelled with the rest (3 cancelled), its payment expired, nothing pending" \
    "$([ "$(q "select coalesce(summary->>'bookings_cancelled', '') from account_deletions where subject_id = '$P' and status = 'data_removed'")" = 3 ] \
       && [ "$(q "select count(*) from bookings b join payments p on p.booking_id = b.id where b.court_id = '$C3' and (b.status <> 'cancelled' or p.status <> 'expired')")" = 0 ] \
       && [ "$(q "select count(*) from payments where status = 'pending' and booking_id in (select id from bookings where court_id in ('$C1','$C2','$C3'))")" = 0 ] && echo true)" \
    "$(q "select summary::text from account_deletions where subject_id = '$P' and status = 'data_removed'") / C3: $(q "select string_agg(b.status || ':' || coalesce(p.status::text, '-') || ':' || coalesce(b.player_id::text, 'anon'), ',') from bookings b left join payments p on p.booking_id = b.id where b.court_id = '$C3'")"

$PSQL -q -d postgres -c "drop database if exists $DB" >/dev/null
echo; echo "summary: $oks ok, $fails FAIL"
[ $fails = 0 ] && echo "RESULT: PASS" || { echo "RESULT: FAIL"; exit 1; }
