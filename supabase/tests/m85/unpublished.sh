#!/usr/bin/env bash
# 0085 tests (unpublished clubs unreadable) and mutation checks.
#
# LOCAL DISPOSABLE REPLICA ONLY: refuses unless connected to the local `courtbook_test` database (built by run.sh).
# Each run is ONE transaction that is ROLLED BACK; the replica is checked unchanged afterwards.
#
#   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh
#   PSQL="sudo -u postgres psql" bash supabase/tests/m85/unpublished.sh
PSQL=${PSQL:-psql}
DB=courtbook_test
MIGRATION=${MIGRATION:-supabase/migrations/0085_unpublished_clubs_private.sql}
TESTS=supabase/tests/m85/unpublished_tests.sql
where=$($PSQL -At -d $DB -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;;
  *) echo "refusing: connected to '$where', expected the local courtbook_test replica"; exit 2;; esac
fp() { $PSQL -At -d $DB -c "select md5(string_agg(p.proname || pg_get_functiondef(p.oid), '' order by p.proname, p.oid)) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'"; }
before=$(fp)
run() { $PSQL -d $DB -X -q -At -v mig="$1" -f $TESTS 2>&1; }

status=0
echo "== 0085 tests against $MIGRATION"
out=$(run "$MIGRATION")
[ -n "${VERBOSE:-}" ] && echo "$out" | grep -E "^ok "
echo "$out" | grep -E "^(FAIL|ERROR|psql)" || true
summary=$(echo "$out" | grep -E "^FAILED " | tail -1)
oks=$(echo "$out" | grep -c "^ok ")
echo "   $oks checks passed; ${summary:-no summary (the run stopped)}"
[ "$summary" = "FAILED 0 of $oks" ] || status=1

echo "== mutation checks (each mutant must make the suite fail)"
tmp=$(mktemp -d); chmod 755 "$tmp"
mutants=(
  "M1 the published check is dropped|s/  select (coalesce((select c.active from clubs c where c.id = p_club), false)            -- 0085: published only/  select (true/"
  "M2 staff and admins lose their unpublished club|s/      or (auth.uid() is not null and (is_staff_of(p_club) or is_admin()));/      ;/"
  "M3 demo hiding forgotten|s/          and (not coalesce(p_is_demo, false) or not demo_clubs_hidden()))/          )/"
  "M4 busy times of hidden clubs shown (bookings)|s/    AND (bookings.player_id = auth.uid() OR club_id_visible_to_me(bookings.club_id))          -- 0085//"
  "M5 busy times of hidden clubs shown (blocks)|s/  WHERE club_id_visible_to_me(blocks.club_id);                                                  -- 0085/  ;/"
  "M6 players lose their own booking's busy time|s/    AND (bookings.player_id = auth.uid() OR club_id_visible_to_me(bookings.club_id))/    AND club_id_visible_to_me(bookings.club_id)/"
  "M7 unknown clubs count as published|s/c.id = p_club), false)            -- 0085/c.id = p_club), true)            -- 0085/;s/    AND (bookings.player_id = auth.uid() OR club_id_visible_to_me(bookings.club_id))          -- 0085/    AND (bookings.player_id = auth.uid() OR club_visible_to_me(bookings.club_id, false) and false)/"
)
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
