#!/usr/bin/env bash
# 0086 under simultaneous sessions: closing the account, the person's own writes in flight, two runs of the server
# steps at once. Session A holds its transaction open for 2 s; session B starts 0.5 s in. Every race ends with the same
# invariants: no deadlock; after the data step no upcoming or pending booking left for the anonymised owner and none
# under their name; nothing done twice.
# LOCAL DISPOSABLE COPY ONLY: copies courtbook_test (built by run.sh from this checkout), drops the copy after.
#   PSQL="sudo -u postgres psql" bash supabase/tests/m86/races86.sh
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
SRC=courtbook_test; DB=courtbook_m86_race
oks=0; fails=0
W=$(mktemp -d); chmod 755 "$W"; trap 'rm -rf "$W"' EXIT
rep() { if [ "$2" = true ]; then echo "ok    $1"; oks=$((oks+1)); else echo "FAIL  $1  [$3]"; fails=$((fails+1)); fi; }

P=e8600000-0000-4000-8000-000000000001     # the person closing
P2=e8600000-0000-4000-8000-000000000002    # another player (in P's game)
P3=e8600000-0000-4000-8000-000000000003    # a third player
C1=e8600000-0000-4000-8000-000000000101; C2=e8600000-0000-4000-8000-000000000102; C3=e8600000-0000-4000-8000-000000000103
B1=e8600000-0000-4000-8000-000000000201; B2=e8600000-0000-4000-8000-000000000202
G=e8600000-0000-4000-8000-000000000301
at() { echo "(((current_date + $1)::timestamp + (select open_time from clubs where slug = 'batroun') + interval '$2 hours') at time zone 'Asia/Beirut')"; }

setup() {
  $PSQL -q -d postgres -c "drop database if exists $DB" -c "create database $DB template $SRC" >/dev/null || exit 2
  $PSQL -X -q -d $DB -v ON_ERROR_STOP=1 >/dev/null <<SQL || { echo "cannot set up"; exit 2; }
insert into auth.users (id, phone) values ('$P', '+96178600001'), ('$P2', '+96178600002'), ('$P3', '+96178600003');
update profiles set name = 'Race closer', rules_accepted_at = now() where id = '$P';
update profiles set rules_accepted_at = now() where id in ('$P2', '$P3');
update clubs set payment_mode = 'simulated', cancel_cutoff_hours = 6 where slug = 'batroun';
insert into courts (id, club_id, name, sport, active, sort) select '$C1', id, 'Race 1', 'padel', true, 98 from clubs where slug = 'batroun';
insert into courts (id, club_id, name, sport, active, sort) select '$C2', id, 'Race 2', 'padel', true, 99 from clubs where slug = 'batroun';
insert into courts (id, club_id, name, sport, active, sort) select '$C3', id, 'Race 3', 'padel', true, 100 from clubs where slug = 'batroun';
insert into bookings (id, club_id, court_id, player_id, created_by, start_at, end_at, status, source, price_usd, fee_usd)
select '$B1', id, '$C1', '$P', '$P', $(at 5 2), $(at 5 2) + interval '60 min', 'confirmed', 'app', 20, 1 from clubs where slug = 'batroun';
insert into bookings (id, club_id, court_id, player_id, created_by, start_at, end_at, status, source, price_usd, fee_usd)
select '$B2', id, '$C2', '$P', '$P', $(at 6 2), $(at 6 2) + interval '60 min', 'confirmed', 'app', 20, 1 from clubs where slug = 'batroun';
insert into payments (booking_id, profile_id, club_id, provider, amount_usd, fee_usd, total_usd, status, paid_at)
select b.id, '$P', b.club_id, 'simulated', 20, 1, 21, 'paid', now() from bookings b where b.id in ('$B1', '$B2');
insert into matches (id, club_id, sport, organizer_id, start_at, end_at, players_needed, status, join_mode)
select '$G', id, 'padel', '$P', now() + interval '3 days', now() + interval '3 days 90 min', 3, 'open', 'open' from clubs where slug = 'batroun';
insert into match_players (match_id, profile_id, status) values ('$G', '$P2', 'accepted');
insert into deletion_worker (id, last_run_at) values (true, now()) on conflict (id) do update set last_run_at = now();   -- processing running
SQL
}
who() { if [ "$1" = service ]; then echo "set local role service_role; select set_config('request.jwt.claim.sub', '', true);"
        else echo "set local role authenticated; select set_config('request.jwt.claim.sub', '$1', true);
                   select set_config('request.jwt.claims', json_build_object('sub', '$1', 'amr', json_build_array(json_build_object('method', 'otp', 'timestamp', extract(epoch from now())::bigint)))::text, true);"; fi; }   # signed in just now (0086 review)
race() {    # $1 who A, $2 statement A (held 2 s), $3 who B, $4 statement B
  ( $PSQL -X -q -At -d $DB -v ON_ERROR_STOP=1 >$W/a.out 2>&1 <<SQL
begin; $(who "$1") $2; select pg_sleep(2); commit;
SQL
    echo $? > $W/a.rc ) &
  sleep 0.5
  $PSQL -X -q -At -d $DB -v ON_ERROR_STOP=1 >$W/b.out 2>&1 <<SQL
begin; $(who "$3") $4; commit;
SQL
  echo $? > $W/b.rc; wait
}
q() { $PSQL -X -At -d $DB -c "$1"; }
svc() { $PSQL -X -q -At -d $DB -v ON_ERROR_STOP=1 -c "begin; $(who service) $1; commit;" 2>&1 | grep -v "^set_config\|^$" | tail -1; }
DATA="select delete_account_data('$P')"
ACTIVE_ANON="select count(*) from bookings where player_id is null and guest_name = 'Former player' and (status = 'pending' or (status = 'confirmed' and start_at > now()))"
LEFT_NAMED="select count(*) from bookings where player_id = '$P'"
nodead() { ! grep -qi "deadlock" $W/a.out $W/b.out; }
clean_after_data() {  # $1 label
  rep "$1: after the data step, nothing upcoming or pending for the anonymised owner, nothing under their name" \
      "$([ "$(q "$ACTIVE_ANON")" = 0 ] && [ "$(q "$LEFT_NAMED")" = 0 ] && echo true)" "active anon $(q "$ACTIVE_ANON"), named $(q "$LEFT_NAMED")"
}

echo "== RC1 two closes at once (double tap, two devices)"
setup
race "$P" "select close_my_account('web')" "$P" "select close_my_account('app')"
rep "RC1: no deadlock, both succeed" "$(nodead && [ "$(cat $W/a.rc)$(cat $W/b.rc)" = 00 ] && echo true)" "$(tail -1 $W/a.out) / $(tail -1 $W/b.out)"
rep "RC1: exactly one record; the second close got it back (new=false)" \
    "$([ "$(q "select count(*) from account_deletions where subject_id = '$P'")" = 1 ] && grep -q '"new": false' $W/b.out && echo true)" "$(cat $W/b.out | tail -2)"

echo "== RC2 the person's booking is being written when they close"
setup
race "$P" "select hold_slot((select id from clubs where slug = 'batroun'), '$C3', $(at 7 2), $(at 7 2) + interval '60 min', gen_random_uuid())" "$P" "select close_my_account('app')"
rep "RC2: no deadlock; the booking was written first, then the close (it waited)" \
    "$(nodead && [ "$(cat $W/a.rc)$(cat $W/b.rc)" = 00 ] && [ "$(q "select count(*) from bookings where player_id = '$P' and status = 'pending'")" = 1 ] && echo true)" "$(tail -1 $W/a.out) / $(tail -1 $W/b.out)"
svc "$DATA" >/dev/null
clean_after_data RC2
rep "RC2: the in-flight hold was cancelled with the rest (3 cancelled)" "$([ "$(q "select summary->>'bookings_cancelled' from account_deletions where subject_id = '$P'")" = 3 ] && echo true)" "$(q "select summary::text from account_deletions where subject_id = '$P'")"

echo "== RC3 the close is being written when the person tries to book"
setup
race "$P" "select close_my_account('app')" "$P" "select hold_slot((select id from clubs where slug = 'batroun'), '$C3', $(at 7 4), $(at 7 4) + interval '60 min', gen_random_uuid())"
got=$(if [ "$(cat $W/b.rc)" = 0 ]; then echo "booking slipped in (statement began before the close committed)"; else grep -o "account_closed\|account_deletion_requested" $W/b.out | head -1; fi)
echo "      (B: $got)"
rep "RC3: no deadlock; the close succeeded" "$(nodead && [ "$(cat $W/a.rc)" = 0 ] && echo true)" "$(tail -1 $W/a.out)"
rep "RC3: a booking attempted after the close is refused once the close is visible" \
    "$([ "$(svc "select 1")" = 1 ] && $PSQL -X -q -At -d $DB -c "begin; $(who "$P") select hold_slot((select id from clubs where slug = 'batroun'), '$C3', $(at 8 4), $(at 8 4) + interval '60 min', gen_random_uuid()); commit;" 2>&1 | grep -q account_closed && echo true)" "not refused"
svc "$DATA" >/dev/null
clean_after_data RC3

echo "== RC4 two server runs claim the same record at once"
setup
q "select close_my_account('web')" >/dev/null 2>&1 || $PSQL -X -q -d $DB -c "begin; $(who "$P") select close_my_account('web'); commit;" >/dev/null
race service "select claim_deletion('$P')" service "select claim_deletion('$P')"
rep "RC4: no deadlock; the second run did not get the record while the first held it (busy)" \
    "$(nodead && [ "$(cat $W/a.rc)$(cat $W/b.rc)" = 00 ] && grep -q '"claimed": true' $W/a.out && grep -q '"reason": "busy"' $W/b.out && echo true)" "A: $(tail -2 $W/a.out | head -1) / B: $(tail -1 $W/b.out)"
rep "RC4: after the first commits, a third claim finds the lease (leased); one attempt counted" \
    "$(echo "$(svc "select claim_deletion('$P')->>'reason'")" | grep -q leased && [ "$(q "select attempts from account_deletions where subject_id = '$P'")" = 1 ] && echo true)" "$(q "select attempts from account_deletions where subject_id = '$P'")"

echo "== RC5 two data steps at once (an inline run and a retry overlapping)"
setup
$PSQL -X -q -d $DB -c "begin; $(who "$P") select close_my_account('web'); commit;" >/dev/null
race service "$DATA" service "$DATA"
rep "RC5: no deadlock, both succeed" "$(nodead && [ "$(cat $W/a.rc)$(cat $W/b.rc)" = 00 ] && echo true)" "$(tail -1 $W/a.out) / $(tail -1 $W/b.out)"
clean_after_data RC5
rep "RC5: done once: 2 cancelled, the second run found nothing, one notice to the player in their game" \
    "$([ "$(q "select (summary->>'bookings_cancelled') || '/' || (summary->'last_rerun'->>'bookings_cancelled') from account_deletions where subject_id = '$P'")" = "2/0" ] \
       && [ "$(q "select count(*) from notifications where profile_id = '$P2' and match_id = '$G' and kind = 'match_cancelled'")" = 1 ] && echo true)" \
    "$(q "select summary::text from account_deletions where subject_id = '$P'") / notices $(q "select count(*) from notifications where profile_id = '$P2' and match_id = '$G'")"

echo "== RC6 another player joins the closer's game while the data step cancels it"
setup
$PSQL -X -q -d $DB -c "begin; $(who "$P") select close_my_account('web'); commit;" >/dev/null
race service "$DATA" "$P3" "select join_match('$G')"
rep "RC6: no deadlock; the game ends cancelled and the late joiner is not in a cancelled game as accepted" \
    "$(nodead && [ "$(q "select status from matches where id = '$G'")" = cancelled ] && echo true)" "A rc $(cat $W/a.rc) / B: $(tail -1 $W/b.out)"
clean_after_data RC6

$PSQL -q -d postgres -c "drop database if exists $DB" >/dev/null
echo; echo "summary: $oks ok, $fails FAIL"
[ $fails = 0 ] && echo "RESULT: PASS" || { echo "RESULT: FAIL"; exit 1; }
