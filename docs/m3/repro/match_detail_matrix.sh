#!/usr/bin/env bash
# Authorisation matrix for the proposed match_detail (docs/m3/sql/0067_match_detail.draft.sql).
# LOCAL REPLICA ONLY. Everything runs inside ONE transaction that is rolled back: the draft function,
# the test users and the games never persist.
#   PSQL="sudo -u postgres psql" bash docs/m3/repro/match_detail_matrix.sh
set -u
PSQL=${PSQL:-psql}
DB=courtbook_test
where=$($PSQL -At -d $DB -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;; *) echo "refusing: '$where'"; exit 1;; esac
HERE=$(cd "$(dirname "$0")" && pwd)

u() { printf 'b0000000-0000-0000-0000-0000000000%s' "$1"; }
O=$(u 01) A=$(u 02) P=$(u 03) D=$(u 04) R=$(u 05) L=$(u 06) X=$(u 07) S=$(u 08)
CLUB_SQL="(select id from clubs where slug='batroun')"
F="(current_date + 3 + time '18:00') at time zone 'Asia/Beirut'"

{
echo "\\set ON_ERROR_STOP 1"
echo "begin;"
echo "\\i $HERE/../sql/0067_match_detail.draft.sql"
echo "insert into auth.users (id, email) select x, x||'@md.test' from unnest(array['$O','$A','$P','$D','$R','$L','$X','$S']::uuid[]) x;"
echo "insert into club_staff (club_id, profile_id) values ($CLUB_SQL, '$S');"
# game id, status, closed_reason, start, end, court lost
while IFS='|' read -r G ST CR START END LOST; do
  echo "insert into matches (id, club_id, sport, organizer_id, start_at, end_at, players_needed, status, closed_reason, court_lost_at)
        values ('$G', $CLUB_SQL, 'padel', '$O', $START, $END, 4, '$ST', nullif('$CR','-'), case when '$LOST'='y' then now() end);"
  echo "insert into match_players (match_id, profile_id, status) values ('$G','$A','accepted'),('$G','$D','declined'),('$G','$R','declined');"
  [ "$G" != c0000000-0000-0000-0000-000000000003 ] && echo "insert into match_players (match_id, profile_id, status) values ('$G','$P','pending');"
done <<GAMES
c0000000-0000-0000-0000-000000000001|open|-|$F|$F + interval '90 min'|n
c0000000-0000-0000-0000-000000000002|closed|full|$F|$F + interval '90 min'|n
c0000000-0000-0000-0000-000000000003|closed|organizer|$F|$F + interval '90 min'|n
c0000000-0000-0000-0000-000000000004|cancelled|-|$F|$F + interval '90 min'|n
c0000000-0000-0000-0000-000000000005|open|-|now() - interval '30 min'|now() + interval '60 min'|n
c0000000-0000-0000-0000-000000000006|open|-|now() - interval '3 hours'|now() - interval '90 min'|n
c0000000-0000-0000-0000-000000000007|closed|no_court|$F|$F + interval '90 min'|y
GAMES
echo "create temp table seen (who text, g int, n int, my text, pend int, fin bool, lost bool);"
echo "grant all on seen to authenticated;"
for who in O A P D R L X S; do
  id=${!who}
  echo "set local role authenticated; select set_config('request.jwt.claim.sub','$id',true) \\g /dev/null"
  for g in 1 2 3 4 5 6 7; do
    echo "insert into seen select '$who', $g, count(*), max(my_status), max(pending), bool_or(finished), bool_or(court_lost) from match_detail('c0000000-0000-0000-0000-00000000000$g');"
  done
  echo "reset role;"
done
echo "\\echo"
echo "\\echo 'rows returned (1 = visible). games: 1 open 2 full 3 private 4 cancelled 5 playing 6 played 7 court lost'"
echo "select who, string_agg(n::text, ' ' order by g) as \"1 2 3 4 5 6 7\" from seen group by who order by position(who in 'OAPDRLXS');"
echo "\\echo 'expected: O,A,S = 1 1 1 1 1 1 1 | P = 1 1 0 1 1 1 1 | D,R,L,X = 1 0 0 0 0 0 0'"
echo "select case when bool_and(n = case when who in ('O','A','S') then 1 when who='P' then (g<>3)::int else (g=1)::int end) then 'MATRIX PASS' else 'MATRIX FAIL' end from seen;"
echo "\\echo 'details: declined sees own status; pending count only for the organiser; finished and court_lost flags'"
echo "select (select my from seen where who='D' and g=1) as declined_status,
             (select pend from seen where who='O' and g=1) as organiser_pending,
             (select pend from seen where who='A' and g=1) as player_pending,
             (select fin from seen where who='A' and g=6) as played_finished,
             (select fin from seen where who='A' and g=5) as playing_finished,
             (select lost from seen where who='A' and g=7) as court_lost;"
echo "set local role anon;"
echo "\\set ON_ERROR_STOP 0"
echo "select * from match_detail('c0000000-0000-0000-0000-000000000001');"
echo "rollback;"
} | $PSQL -d $DB -X -q 2>&1 | grep -v -E '^(SET|set_config|-+|)$'
