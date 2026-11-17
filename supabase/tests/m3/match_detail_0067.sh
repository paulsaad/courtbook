#!/usr/bin/env bash
# Regression tests for migration 0067 — match_detail() (docs/m3/06-test-plan.md §AO, T-MD1–MD6).
#
# LOCAL DISPOSABLE REPLICA ONLY. Refuses to run unless connected to the local `courtbook_test`
# database over a local socket or loopback. Every suite run is ONE transaction that is ROLLED BACK:
# the migration, users and games never persist. Nothing here can reach staging or live.
#
#   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh           # builds courtbook_test
#   PSQL="sudo -u postgres psql" bash supabase/tests/m3/match_detail_0067.sh
#
# MIGRATION defaults to the approved draft. When 0067 becomes a real migration file, point it there:
#   MIGRATION=supabase/migrations/0067_match_detail.sql bash supabase/tests/m3/match_detail_0067.sh
#
# Then every mutant below — each one a plausible mistake — must make the suite FAIL. A mutant that
# passes means the tests can't see that mistake, and the script exits non-zero.
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
DB=courtbook_test
MIGRATION=${MIGRATION:-docs/m3/sql/0067_match_detail.draft.sql}

where=$($PSQL -At -d $DB -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;;
  *) echo "refusing: connected to '$where', expected the local courtbook_test replica"; exit 2;; esac
[ -f "$MIGRATION" ] || { echo "missing $MIGRATION"; exit 2; }
before=$($PSQL -At -d $DB -c "select (select count(*) from pg_proc where proname='match_detail')||'/'||(select count(*) from information_schema.columns where table_name='matches' and column_name='court_lost_at')")
[ "$before" = "0/0" ] || { echo "refusing: match_detail or court_lost_at already exists on the replica ($before) — rebuild it with run.sh"; exit 2; }

id() { printf '%s-0000-4000-8000-%012d' "$1" "$2"; }
O=$(id e0000000 1); A=$(id e0000000 2); P=$(id e0000000 3); D=$(id e0000000 4); R=$(id e0000000 5)
L=$(id e0000000 6); X=$(id e0000000 7); S=$(id e0000000 8); SB=$(id e0000000 9); ADM=$(id e0000000 10); NOSUB=none
G() { id f0000000 "$1"; }
CLUB="(select id from clubs where slug='batroun')"
F="(current_date + 3 + time '18:00') at time zone 'Asia/Beirut'"

# one suite run against a migration file; prints "FAILED <n>" last
suite() {
  local mig=$1
  {
    echo "\\set ON_ERROR_STOP 1"
    echo "begin;"
    # T-MD5: the migration applies twice without error
    echo "\\i $mig"
    echo "\\i $mig"
    echo "create temp table t (id text, pass boolean, detail text);"
    echo "insert into t select 'T-MD5 one function after applying twice', count(*) = 1, count(*)::text from pg_proc where proname = 'match_detail';"
    echo "insert into auth.users (id, email) select x, x||'@md.test' from unnest(array['$O','$A','$P','$D','$R','$L','$X','$S','$SB','$ADM']::uuid[]) x;"
    echo "update profiles set roles = '{player,admin}' where id = '$ADM';"
    echo "insert into clubs (name, slug) values ('M3 Other Club', 'm3-other');"
    echo "insert into club_staff (club_id, profile_id) values ($CLUB, '$S'), ((select id from clubs where slug='m3-other'), '$SB');"
    # games: id | status | reason | start | end | court lost
    while IFS='|' read -r N ST CR START END LOST; do
      echo "insert into matches (id, club_id, sport, organizer_id, start_at, end_at, players_needed, status, closed_reason, court_lost_at, note)
            values ('$(G $N)', $CLUB, 'padel', '$O', $START, $END, 4, '$ST', nullif('$CR','-'), case when '$LOST'='y' then now() end, 'Friendly doubles');"
      echo "insert into match_players (match_id, profile_id, status) values ('$(G $N)','$A','accepted'),('$(G $N)','$D','declined'),('$(G $N)','$R','declined');"
      # making a game private removes pending requests (GR-4), so the private game has none
      [ "$N" != 3 ] && echo "insert into match_players (match_id, profile_id, status) values ('$(G $N)','$P','pending');"
    done <<GAMES
1|open|-|$F|$F + interval '90 min'|n
2|closed|full|$F|$F + interval '90 min'|n
3|closed|organizer|$F|$F + interval '90 min'|n
4|cancelled|-|$F|$F + interval '90 min'|n
5|open|-|now() - interval '30 min'|now() + interval '60 min'|n
6|open|-|now() - interval '3 hours'|now() - interval '90 min'|n
7|closed|no_court|$F|$F + interval '90 min'|y
8|open|-|$F + interval '1 day'|$F + interval '1 day 90 min'|n
9|open|-|now() - interval '4 hours'|null|n
10|open|-|now() - interval '2 hours'|null|n
GAMES
    # game 1 has a real court booking; game 8 has none
    echo "with b as (insert into bookings (club_id, court_id, player_id, start_at, end_at, status, source, created_by)
            select c.club_id, c.id, '$O', $F, $F + interval '90 min', 'confirmed', 'app', '$O' from courts c where c.club_id = $CLUB and c.name = 'Padel 1' returning id)
          update matches set booking_id = (select id from b) where id = '$(G 1)';"
    echo "insert into match_hidden (profile_id, match_id) values ('$A', '$(G 6)');"
    echo "create temp table seen (who text, g int, n int, my text, pend int, org uuid, bk uuid, has_court bool, cname text, note text,
            club text, started bool, finished bool, lost bool, hidden bool, organise bool);"
    echo "grant all on seen to authenticated, anon;"
    for who in O A P D R L X S SB ADM NOSUB; do
      echo "set local role authenticated;"
      if [ "$who" = NOSUB ]; then echo "select set_config('request.jwt.claim.sub', '', true) \\g /dev/null"
      else echo "select set_config('request.jwt.claim.sub', '${!who}', true) \\g /dev/null"; fi
      for n in 1 2 3 4 5 6 7 8 9 10; do
        echo "insert into seen select '$who', $n, count(*), max(my_status), max(pending), (array_agg(organizer_id))[1], (array_agg(booking_id))[1],
                bool_or(has_court), max(court_name), max(note), max(club_name), bool_or(started), bool_or(finished), bool_or(court_lost),
                bool_or(hidden), bool_or(i_organize) from match_detail('$(G $n)');"
      done
      echo "insert into seen select '$who', 0, count(*) from match_detail('$(id f0000000 999)');"
      echo "reset role;"
    done
    # T-MD2: anonymous callers cannot execute it at all
    echo "insert into t select 'T-MD2 anon has no execute privilege', not has_function_privilege('anon', 'match_detail(uuid)', 'execute'), '';"
    echo "insert into t select 'T-MD2 authenticated has execute privilege', has_function_privilege('authenticated', 'match_detail(uuid)', 'execute'), '';"
    echo "create temp table anon_try (outcome text); grant all on anon_try to anon;"
    echo "set local role anon;"
    echo "do \$\$ begin perform match_detail('$(G 1)'); insert into anon_try values ('returned'); exception when insufficient_privilege then insert into anon_try values ('refused'); end \$\$;"
    echo "reset role;"
    echo "insert into t select 'T-MD2 anon call is refused', (select outcome from anon_try) = 'refused', (select outcome from anon_try);"
    cat <<'SQL'
-- T-MD1: visibility matrix (GR-2)
with expected as (
  select who, g,
    case
      when who = 'NOSUB' then 0
      when who in ('O','A','S','ADM') then 1
      when who = 'P' then (g <> 3)::int                 -- requester: every state except private (request removed)
      else (g in (1, 8))::int                          -- declined, removed, left, stranger, other club's staff:
    end as n                                            --   only while open and not started
  from (select distinct who, g from seen where g between 1 and 10) s
)
insert into t select 'T-MD1 ' || e.who || ' game ' || e.g, s.n = e.n, 'saw ' || s.n || ', expected ' || e.n
from expected e join seen s using (who, g);
insert into t select 'T-MD1 unknown game id → no row (' || who || ')', n = 0, n::text from seen where g = 0;

-- T-MD3: the request count is the organiser's only
insert into t select 'T-MD3 organiser sees request count', pend = 1, coalesce(pend::text, 'null') from seen where who = 'O' and g = 1;
insert into t select 'T-MD3 no request count for ' || who, pend is null, coalesce(pend::text, 'null') from seen where who <> 'O' and g = 1 and n = 1;

-- T-MD4: flags and the caller's own status
insert into t values
  ('T-MD4 playing: started, not finished', (select started and not finished from seen where who = 'A' and g = 5), ''),
  ('T-MD4 played: started and finished', (select started and finished from seen where who = 'A' and g = 6), ''),
  ('T-MD4 no end time, started 4 h ago: finished (start + 3 h rule)', (select finished from seen where who = 'A' and g = 9), ''),
  ('T-MD4 no end time, started 2 h ago: playing', (select started and not finished from seen where who = 'A' and g = 10), ''),
  ('T-MD4 future game: not started', (select not started and not finished from seen where who = 'A' and g = 1), ''),
  ('T-MD4 court lost flag', (select lost from seen where who = 'A' and g = 7), ''),
  ('T-MD4 court lost false elsewhere', (select not lost from seen where who = 'A' and g = 1), ''),
  ('T-MD4 hidden is the caller''s own (A hid game 6)', (select hidden from seen where who = 'A' and g = 6), ''),
  ('T-MD4 hidden not shared (O did not hide game 6)', (select not hidden from seen where who = 'O' and g = 6), ''),
  ('T-MD4 my_status accepted', (select my = 'accepted' from seen where who = 'A' and g = 1), ''),
  ('T-MD4 my_status pending', (select my = 'pending' from seen where who = 'P' and g = 1), ''),
  ('T-MD4 my_status declined (declined player)', (select my = 'declined' from seen where who = 'D' and g = 1), ''),
  ('T-MD4 my_status declined (removed player)', (select my = 'declined' from seen where who = 'R' and g = 1), ''),
  ('T-MD4 organiser: no player row, i_organize', (select my is null and organise from seen where who = 'O' and g = 1), ''),
  ('T-MD4 stranger: no status, not organiser', (select my is null and not organise from seen where who = 'X' and g = 1), '');

-- T-MD6: field review (safeguard S-A) — identifiers only for insiders
insert into t select 'T-MD6 organizer_id ' || case when who in ('O','A','S','ADM') then 'shown to ' else 'hidden from ' end || who,
  (org is not null) = (who in ('O','A','S','ADM')), coalesce(org::text, 'null') from seen where g = 1 and n = 1;
insert into t select 'T-MD6 booking_id ' || case when who in ('O','A','S','ADM') then 'shown to ' else 'hidden from ' end || who,
  (bk is not null) = (who in ('O','A','S','ADM')), coalesce(bk::text, 'null') from seen where g = 1 and n = 1;
insert into t select 'T-MD6 has_court and court name for everyone who sees game 1 (' || who || ')',
  has_court and cname = 'Padel 1', coalesce(cname, 'null') from seen where g = 1 and n = 1;
insert into t select 'T-MD6 game without a booking: has_court false, no court name (' || who || ')',
  not has_court and cname is null and bk is null, coalesce(cname, 'null') from seen where g = 8 and n = 1;
insert into t select 'T-MD6 public description visible where the game is (' || who || ')',
  note = 'Friendly doubles' and club is not null, coalesce(note, 'null') from seen where g = 1 and n = 1;
SQL
    echo "\\echo"
    echo "select case when pass then 'ok   ' else 'FAIL ' end || id || case when pass then '' else '  [' || coalesce(detail, '') || ']' end from t order by pass, id;"
    echo "select 'FAILED ' || count(*) filter (where not pass or pass is null) || ' of ' || count(*) from t;"
    echo "rollback;"
  } | $PSQL -d $DB -X -q -At 2>&1
}

status=0
echo "== match_detail tests against $MIGRATION"
out=$(suite "$MIGRATION")
[ -n "${VERBOSE:-}" ] && echo "$out" | grep -E "^ok "
echo "$out" | grep -E "^(FAIL|FAILED|ERROR|psql)" | grep -v "NOTICE" || true
summary=$(echo "$out" | grep -E "^FAILED " | tail -1)
oks=$(echo "$out" | grep -c "^ok ")
echo "   $oks checks passed; $summary"
[ "$summary" = "FAILED 0 of $oks" ] || status=1

echo "== mutation checks (each mutant must make the suite fail)"
mutants=(
  "M1 strangers see started games|s/or (m.status = 'open' and m.start_at > now())/or (m.status = 'open')/"
  "M2 booking_id shown to everyone|s/case when insider then m.booking_id end/m.booking_id/"
  "M3 organizer_id shown to everyone|s/case when insider then m.organizer_id end/m.organizer_id/"
  "M4 requesters lose sight of their game|s/me.status in ('accepted', 'pending')/me.status = 'accepted'/"
  "M5 anon may execute|s/revoke all on function match_detail(uuid) from public, anon;/grant execute on function match_detail(uuid) to anon;/"
  "M6 request count for everyone|s/case when m.organizer_id = auth.uid() then\$/case when true then/"
  "M7 no signed-in check|s/and auth.uid() is not null/and true/"
  "M8 staff clause dropped|s/or is_staff_of(m.club_id) /or false /"
  "M9 requesters treated as insiders|s/or me.status = 'accepted'\$/or me.status in ('accepted', 'pending')/"
)
tmp=$(mktemp -d)
chmod 755 "$tmp"   # psql may run as another user (sudo -u postgres) and must read the mutant
for m in "${mutants[@]}"; do
  name=${m%%|*}; expr=${m#*|}
  sed "$expr" "$MIGRATION" > "$tmp/mutant.sql"; chmod 644 "$tmp/mutant.sql"
  if cmp -s "$MIGRATION" "$tmp/mutant.sql"; then echo "   $name: NOT APPLIED (pattern not found) — fix the mutant"; status=1; continue; fi
  res=$(suite "$tmp/mutant.sql" | grep -E "^FAILED " | tail -1)
  if [ -n "$res" ] && [ "${res#FAILED 0 }" = "$res" ]; then echo "   $name: detected ($res)"
  else echo "   $name: NOT DETECTED (${res:-no result}) — the suite cannot see this mistake"; status=1; fi
done
rm -rf "$tmp"

after=$($PSQL -At -d $DB -c "select (select count(*) from pg_proc where proname='match_detail')||'/'||(select count(*) from information_schema.columns where table_name='matches' and column_name='court_lost_at')")
echo "== replica after the run: match_detail functions / court_lost_at columns = $after (expected 0/0: everything rolled back)"
[ "$after" = "0/0" ] || status=1
[ $status = 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"
exit $status
