#!/usr/bin/env bash
# 0087–0089 tests (favourites visibility, playing areas, last area, first-use question, club map points) and
# mutation checks. The frozen favourites suite (supabase/tests/favourites/) covers the rest of 0087.
#
# LOCAL DISPOSABLE REPLICA ONLY: refuses unless connected to the local `courtbook_test` database (built by run.sh).
# Each run is ONE transaction that is ROLLED BACK; the replica is checked unchanged afterwards.
#
#   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh
#   PSQL="sudo -u postgres psql" bash supabase/tests/repeat_use/repeat_use.sh
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
DB=courtbook_test
M87=supabase/migrations/0087_club_favourites.sql
M88=supabase/migrations/0088_playing_areas.sql
M89=supabase/migrations/0089_publish_needs_map_point.sql
TESTS=supabase/tests/repeat_use/repeat_use_tests.sql
where=$($PSQL -At -d $DB -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;;
  *) echo "refusing: connected to '$where', expected the local courtbook_test replica"; exit 2;; esac
fp() { $PSQL -At -d $DB -c "select md5(string_agg(p.proname || pg_get_functiondef(p.oid), '' order by p.proname, p.oid)) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'"; }
cons() { $PSQL -At -d $DB -c "select count(*) from pg_constraint where conname = 'clubs_map_point_pair'"; }
before=$(fp); before_c=$(cons)
run() { $PSQL -d $DB -X -q -At -v m87="$1" -v m88="$2" -v m89="$3" -f $TESTS 2>&1; }

status=0
echo "== 0087–0089 tests"
out=$(run $M87 $M88 $M89)
[ -n "${VERBOSE:-}" ] && echo "$out" | grep -E "^ok "
echo "$out" | grep -E "^(FAIL|ERROR|psql)" || true
summary=$(echo "$out" | grep -E "^FAILED " | tail -1)
oks=$(echo "$out" | grep -c "^ok ")
echo "   $oks checks passed; ${summary:-no summary (the run stopped)}"
[ "$summary" = "FAILED 0 of $oks" ] || status=1

echo "== mutation checks (each mutant must make the suite fail)"
tmp=$(mktemp -d); chmod 755 "$tmp"
mutants=(
  "87|F1 unpublished clubs can be favourited|s/where c.id = p_club and club_visible_to_me(c.id, c.is_demo))/where c.id = p_club)/"
  "87|F2 hidden clubs are listed|s/join clubs c on c.id = f.club_id and club_visible_to_me(c.id, c.is_demo)/join clubs c on c.id = f.club_id/"
  "88|A1 a district from another governorate accepted|s/where code = p_district and governorate_code = p_gov)/where code = p_district)/"
  "88|A2 a town from another district accepted|s/where id = p_town and district_code = p_district)/where id = p_town)/"
  "88|A3 no limit on areas|s/jsonb_array_length(p_areas) > 10/jsonb_array_length(p_areas) > 100/"
  "88|A4 duplicates kept|s/      continue;/      null;/"
  "88|A5 answering does not mark the question|s/  insert into player_prefs (profile_id, areas_asked_at) values (me, now())/  insert into player_prefs (profile_id, areas_asked_at) values (me, null)/"
  "88|A6 everyone reads everyone's areas|s/create policy \"player_areas: own read\" on player_areas for select to authenticated using (profile_id = auth.uid());/create policy \"player_areas: own read\" on player_areas for select to authenticated using (true);/"
  "88|A7 players may write the tables|s/^grant select on player_areas, player_prefs to authenticated;/grant select, insert, update, delete on player_areas, player_prefs to authenticated;/"
  "88|A8 signed-out callers may call|s/^revoke all on function set_playing_areas(jsonb) from public, anon;/grant execute on function set_playing_areas(jsonb) to anon;/"
  "88|A9 the internal check callable by players|s/^revoke all on function playing_area_checked(text, text, uuid) from public, anon, authenticated;/grant execute on function playing_area_checked(text, text, uuid) to authenticated;/"
  "88|A10 half map points accepted|s/check ((lat is null) = (lng is null)) not valid;/check (true) not valid;/"
  "88|A11 the last area not validated|s/    perform playing_area_checked(p_governorate, p_district, p_town);/    null;/"
  # (dropping only the "p_district is null" clause is an equivalent mutant: the town lookup then refuses anyway)
  "88|A12 the town check removed (towns accepted anywhere)|s/  if p_town is not null and (p_district is null or not exists/  if false and (p_district is null or not exists/"
  "88|A13 rows read by other players through my_playing_prefs|s/       where a.profile_id = auth.uid()), '\[\]'::jsonb),/       ), '[]'::jsonb),/"
  "89|M1 publishing without a map point|s/                         and c.lat is not null and c.lng is not null;                                         -- 0089/                         ;/"
)
for m in "${mutants[@]}"; do
  which=${m%%|*}; rest=${m#*|}; name=${rest%%|*}; expr=${rest#*|}
  case $which in 87) src=$M87;; 88) src=$M88;; 89) src=$M89;; esac
  sed "$expr" "$src" > "$tmp/mutant.sql"; chmod 644 "$tmp/mutant.sql"
  if cmp -s "$src" "$tmp/mutant.sql"; then echo "   $name: NOT APPLIED (pattern not found) — fix the mutant"; status=1; continue; fi
  case $which in
    87) res=$(run "$tmp/mutant.sql" $M88 $M89 | grep -E "^FAILED " | tail -1);;
    88) res=$(run $M87 "$tmp/mutant.sql" $M89 | grep -E "^FAILED " | tail -1);;
    89) res=$(run $M87 $M88 "$tmp/mutant.sql" | grep -E "^FAILED " | tail -1);;
  esac
  if [ -n "$res" ] && [ "${res#FAILED 0 }" = "$res" ]; then echo "   $name: detected ($res)"
  else echo "   $name: NOT DETECTED (${res:-no result}) — the suite cannot see this mistake"; status=1; fi
done
rm -rf "$tmp"

[ "$(fp)" = "$before" ] && [ "$(cons)" = "$before_c" ] && echo "== replica unchanged (functions and constraint identical before and after)" || { echo "== replica CHANGED"; status=1; }
[ $status = 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"
exit $status
