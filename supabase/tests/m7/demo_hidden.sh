#!/usr/bin/env bash
# M7 tests (0078 hide demo clubs) and mutation checks.
#
# LOCAL DISPOSABLE REPLICA ONLY: refuses unless connected to the local `courtbook_test` database (built by run.sh).
# Each run is ONE transaction that is ROLLED BACK; the replica is checked unchanged afterwards.
#
#   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh
#   PSQL="sudo -u postgres psql" bash supabase/tests/m7/demo_hidden.sh
PSQL=${PSQL:-psql}
DB=courtbook_test
MIGRATION=${MIGRATION:-supabase/migrations/0078_hide_demo_clubs.sql}
TESTS=supabase/tests/m7/demo_hidden_tests.sql
where=$($PSQL -At -d $DB -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;;
  *) echo "refusing: connected to '$where', expected the local courtbook_test replica"; exit 2;; esac
fp() { $PSQL -At -d $DB -c "select md5(string_agg(p.proname || pg_get_functiondef(p.oid), '' order by p.proname, p.oid)) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'"; }
before=$(fp)
run() { $PSQL -d $DB -X -q -At -v mig="$1" -f $TESTS 2>&1; }

status=0
echo "== M7 tests against $MIGRATION"
out=$(run "$MIGRATION")
[ -n "${VERBOSE:-}" ] && echo "$out" | grep -E "^ok "
echo "$out" | grep -E "^(FAIL|ERROR|psql)" || true
summary=$(echo "$out" | grep -E "^FAILED " | tail -1)
oks=$(echo "$out" | grep -c "^ok ")
echo "   $oks checks passed; ${summary:-no summary (the run stopped)}"
[ "$summary" = "FAILED 0 of $oks" ] || status=1

echo "== mutation checks (each mutant must make the suite fail)"
mutants=(
  "M1 RLS ignores the switch|s/create policy \"clubs: read\" on clubs for select using (club_readable_by_me(id, is_demo));/create policy \"clubs: read\" on clubs for select using (true);/"
  "M2 discovery not filtered|s/  where c.active and club_visible_to_me(c.id, c.is_demo)/  where c.active/"
  "M3 day slots not filtered|s/    where cl.active and club_visible_to_me(cl.id, cl.is_demo)/    where cl.active/"
  "M4 board not filtered|s/^    and club_visible_to_me(c.id, c.is_demo)\$//"
  "M5 coach directory not filtered|s/and cl.active and club_visible_to_me(cl.id, cl.is_demo)/and cl.active/"
  "M6 both booking guards removed (slot check and price)|s/  if c.is_demo and auth.uid() is not null and not club_visible_to_me(p_club, true) then/  if false then/;s/  if not club_visible_to_me(c.id, c.is_demo) then raise exception 'club_not_found'; end if;   -- 0078/  null;/"
  "M7 staff lose access|s/      or (auth.uid() is not null and (is_staff_of(p_club) or is_admin()));/      ;/"
  "M8 hidden by default|s/'hide_demo_clubs'), 'false') = 'true'/'hide_demo_clubs'), 'true') = 'true'/"
  "M9 server jobs refused|s/  if c.is_demo and auth.uid() is not null and not club_visible_to_me(p_club, true) then/  if c.is_demo and not club_visible_to_me(p_club, true) then/"
  "M10 history exception removed|s/  select club_visible_to_me(p_club, p_is_demo) or club_has_my_history(p_club);/  select club_visible_to_me(p_club, p_is_demo);/"
  "M11 history check ignores the user|s/b.club_id = p_club and b.player_id = auth.uid())/b.club_id = p_club)/"
  "M12 history leaks into discovery|s/  where c.active and club_visible_to_me(c.id, c.is_demo)/  where c.active and club_readable_by_me(c.id, c.is_demo)/"
  "M13 match_board not filtered|s/ and not players_blocked(auth.uid(), m.organizer_id) and club_visible_to_me(m.club_id, c.is_demo))/ and not players_blocked(auth.uid(), m.organizer_id))/"
  "M14 open games readable from the table|s/  (status = 'open' and club_id_visible_to_me(club_id)) or organizer_id/  (status = 'open') or organizer_id/"
  "M15 courts readable by anyone|s/create policy \"courts: read\" on courts for select using (club_id_readable_by_me(club_id));/create policy \"courts: read\" on courts for select using (true);/"
  "M16 posting a game at the hidden club|s/  if not club_id_visible_to_me(p_club) then raise exception 'club_not_found'; end if;   -- 0078: no new game at a hidden club/  null;/"
  "M17 joining a game at the hidden club|s/  if not club_id_visible_to_me(m.club_id) then raise exception 'not_found'; end if;   -- 0078/  null;/"
  "M18 game detail not filtered|s/ and m.start_at > now() and club_visible_to_me(m.club_id, c.is_demo))  -- anyone signed in/ and m.start_at > now())  -- anyone signed in/"
  "M19 price quotes for the hidden club|s/  if not club_visible_to_me(c.id, c.is_demo) then raise exception 'club_not_found'; end if;   -- 0078/  null;/"
)
tmp=$(mktemp -d); chmod 755 "$tmp"
for m in "${mutants[@]}"; do
  name=${m%%|*}; expr=${m#*|}
  sed "$expr" "$MIGRATION" > "$tmp/mutant.sql"; chmod 644 "$tmp/mutant.sql"
  if cmp -s "$MIGRATION" "$tmp/mutant.sql"; then echo "   $name: NOT APPLIED (pattern not found) — fix the mutant"; status=1; continue; fi
  res=$(run "$tmp/mutant.sql" | grep -E "^FAILED " | tail -1)
  if [ -n "$res" ] && [ "${res#FAILED 0 }" = "$res" ]; then echo "   $name: detected ($res)"
  else echo "   $name: NOT DETECTED (${res:-no result}) — the suite cannot see this mistake"; status=1; fi
done
rm -rf "$tmp"

[ "$(fp)" = "$before" ] && echo "== replica unchanged (functions identical before and after)" || { echo "== replica CHANGED"; status=1; }
[ $status = 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"
exit $status
