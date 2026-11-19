#!/usr/bin/env bash
# M3-H limits under simultaneous requests (S12): two sessions, the first holds its transaction open
# for 2 s, the second starts during it. With the per-user lock the second waits, then counts the
# first's row and is refused; with the lock removed (control) both pass and the limit is exceeded.
# LOCAL DISPOSABLE COPY ONLY: copies courtbook_test (needs 0067), applies the draft, drops the copy.
#   PSQL="sudo -u postgres psql" bash supabase/tests/m3/hardening_races.sh
set -u
PSQL=${PSQL:-psql}
SRC=courtbook_test; DB=courtbook_m3h_race
MIGRATION=${MIGRATION:-docs/m3/sql/m3h_game_hardening.draft.sql}
oks=0; fails=0
W=$(mktemp -d); chmod 755 "$W"; trap 'rm -rf "$W"' EXIT
rep() { if [ "$2" = true ]; then echo "ok    $1"; oks=$((oks+1)); else echo "FAIL  $1  [$3]"; fails=$((fails+1)); fi; }

R1=e2000000-0000-4000-8000-000000000001   # organiser with 9 live games
R2=e2000000-0000-4000-8000-000000000002   # player with 19 waiting requests
R3=e2000000-0000-4000-8000-000000000003   # sender with 29 messages in the last 10 minutes
R4=e2000000-0000-4000-8000-000000000004   # hosts the games R2 asks to join and the chat game
gid() { printf 'f2000000-0000-4000-8000-%012d' "$1"; }

setup() {   # $1 = migration file to apply on a fresh copy
  $PSQL -q -d postgres -c "drop database if exists $DB" -c "create database $DB template $SRC" >/dev/null || exit 2
  $PSQL -X -q -d $DB -v ON_ERROR_STOP=1 -1 -f "$1" >/dev/null 2>&1 || { echo "cannot apply $1"; exit 2; }
  $PSQL -X -q -d $DB -v ON_ERROR_STOP=1 >/dev/null <<SQL
insert into auth.users (id, email) values ('$R1','r1@race.test'), ('$R2','r2@race.test'), ('$R3','r3@race.test'), ('$R4','r4@race.test');
insert into matches (id, club_id, sport, organizer_id, start_at, players_needed, join_mode)
select ('f2000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, (select id from clubs where slug = 'batroun'), 'padel',
       case when i <= 9 then '$R1'::uuid else '$R4'::uuid end, now() + (i || ' days')::interval, 4, 'approval'
from generate_series(1, 31) i;                                   -- 1–9: R1's; 10–31: R4's
insert into match_players (match_id, profile_id, status)
select ('f2000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, '$R2', 'pending' from generate_series(10, 28) i;   -- 19 waiting
insert into match_players (match_id, profile_id, status) values ('$(gid 31)', '$R3', 'accepted');
insert into match_messages (match_id, profile_id, body) select '$(gid 31)', '$R3', 'm' || i from generate_series(1, 29) i;
SQL
}
as_user() { echo "set local role authenticated; select set_config('request.jwt.claim.sub', '$1', true);"; }
race() {    # $1 user, $2 statement for session A, $3 statement for session B → prints "A:<rc> B:<rc>"
  ( $PSQL -X -q -d $DB -v ON_ERROR_STOP=1 >$W/race_a.out 2>&1 <<SQL
begin; $(as_user "$1") $2; select pg_sleep(2); commit;
SQL
    echo $? > $W/race_a.rc ) &
  sleep 0.5
  $PSQL -X -q -d $DB -v ON_ERROR_STOP=1 >$W/race_b.out 2>&1 <<SQL
begin; $(as_user "$1") $3; commit;
SQL
  echo $? > $W/race_b.rc; wait
}
count() { $PSQL -X -At -d $DB -c "$1"; }
post() { echo "select post_match((select id from clubs where slug = 'batroun'), 'padel', now() + interval '$1 days', null, null, null, 4, null, null)"; }
say() { echo "insert into match_messages (match_id, profile_id, body) values ('$(gid 31)', '$R3', '$1')"; }

LIVE="select count(*) from matches where organizer_id = '$R1' and status <> 'cancelled' and start_at > now()"
WAIT="select count(*) from match_players mp join matches m on m.id = mp.match_id where mp.profile_id = '$R2' and mp.status = 'pending' and m.status <> 'cancelled' and m.start_at > now()"
MSGS="select count(*) from match_messages where match_id = '$(gid 31)' and profile_id = '$R3' and created_at > now() - interval '10 minutes'"

run_all() {   # $1 label, $2 migration file, $3 expected relation: "within" (protected) or "over" (control)
  setup "$2"
  race $R1 "$(post 40)" "$(post 41)"; n=$(count "$LIVE")
  [ "$3" = within ] && rep "RC1 two simultaneous posts at 9 live games: 10 in the end, the second refused (too_many_games)" "$([ "$n" = 10 ] && grep -q too_many_games $W/race_b.out && echo true)" "$n live; $(tail -1 $W/race_b.out)" \
                    || rep "RC1 control without the lock: limit exceeded" "$([ "$n" = 11 ] && echo true)" "$n live"
  race $R2 "select join_match('$(gid 29)')" "select join_match('$(gid 30)')"; n=$(count "$WAIT")
  [ "$3" = within ] && rep "RC2 two simultaneous requests to different games at 19 waiting: 20, the second refused (too_many_requests)" "$([ "$n" = 20 ] && grep -q too_many_requests $W/race_b.out && echo true)" "$n waiting; $(tail -1 $W/race_b.out)" \
                    || rep "RC2 control without the lock: limit exceeded" "$([ "$n" = 21 ] && echo true)" "$n waiting"
  race $R3 "$(say a)" "$(say b)"; n=$(count "$MSGS")
  [ "$3" = within ] && rep "RC3 two simultaneous messages at 29: 30, the second refused (slow_down)" "$([ "$n" = 30 ] && grep -q slow_down $W/race_b.out && echo true)" "$n messages; $(tail -1 $W/race_b.out)" \
                    || rep "RC3 control without the lock: limit exceeded" "$([ "$n" = 31 ] && echo true)" "$n messages"
}

echo "== with the locks ($MIGRATION)"
run_all protected "$MIGRATION" within
echo "== control: the same draft with the three locks removed"
nolock=$W/nolock.sql; grep -v "perform pg_advisory_xact_lock" "$MIGRATION" > "$nolock"
run_all control "$nolock" over
$PSQL -q -d postgres -c "drop database if exists $DB" >/dev/null
echo; echo "summary: $oks ok, $fails FAIL"
[ $fails = 0 ] && echo "RESULT: PASS" || { echo "RESULT: FAIL"; exit 1; }
