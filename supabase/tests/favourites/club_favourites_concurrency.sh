#!/usr/bin/env bash
# Two-session race test for the 50-favourite cap (docs/favourites/sql/club_favourites.draft.sql).
#
# Real concurrency needs committed data that two connections can both see, so this does NOT use
# the shared replica directly: it copies `courtbook_test` into a scratch database
# `courtbook_fav_race`, applies the migration there, races two sessions, and drops the scratch
# database at the end (also on failure). LOCAL ONLY — refuses anything but the local replica.
#
#   PSQL="sudo -u postgres psql" bash supabase/tests/favourites/club_favourites_concurrency.sh
#
# Then it runs the same race against a copy of the migration WITHOUT the per-player lock, and
# requires that copy to break the cap — proof the race is real and the test can see it.
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
SRC=courtbook_test
DB=courtbook_fav_race
MIGRATION=${MIGRATION:-supabase/migrations/0087_club_favourites.sql}   # was the draft until 0087 existed
HOLD=2   # seconds session A keeps its transaction open after adding

where=$($PSQL -At -d $SRC -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;;
  *) echo "refusing: connected to '$where', expected the local courtbook_test replica"; exit 2;; esac

U=d1000000-0000-4000-8000-000000000001
cleanup() { $PSQL -q -d postgres -c "drop database if exists $DB" >/dev/null 2>&1; }
trap cleanup EXIT

q() { $PSQL -X -q -At -d $DB "$@" 2>&1; }
as_u() { printf "set role authenticated;\nselect set_config('request.jwt.claim.sub', '%s', false) \\\\g /dev/null\n%s\n" "$U" "$1"; }

# race: A adds club $1 and holds; B adds club $2 meanwhile. Prints "count|B's answer|B's wait in ms"
race() {
  q -c "delete from club_favourites where profile_id = '$U';" >/dev/null
  q -c "set role postgres;" >/dev/null
  as_u "select count(*) from (select set_club_favourite(id, true) from clubs where slug like 'race-%' and slug not in ('race-x','race-y') order by slug limit 49) z;" | q >/dev/null
  as_u "begin; select set_club_favourite((select id from clubs where slug = '$1'), true); select pg_sleep($HOLD); commit;" | q >/dev/null &
  local a=$!
  sleep 0.7
  local t0; t0=$(date +%s%3N)
  local b; b=$(as_u "select set_club_favourite((select id from clubs where slug = '$2'), true);" | q | grep -oE "^(t|f)$|too_many_favourites" | head -1 | sed 's/^t$/true/; s/^f$/false/')
  local t1; t1=$(date +%s%3N)
  wait $a
  echo "$(q -c "select count(*) from club_favourites where profile_id = '$U'")|$b|$((t1 - t0))"
}

run_against() {
  local mig=$1
  cleanup
  $PSQL -q -d postgres -c "create database $DB template $SRC" >/dev/null || { echo "cannot copy $SRC (is another session connected to it?)"; return 2; }
  q -v ON_ERROR_STOP=1 -f "$mig" >/dev/null || { echo "migration failed"; return 2; }
  q -c "insert into auth.users (id, email) values ('$U', 'race@fav.test');" >/dev/null
  q -c "insert into clubs (name, slug) select 'Race ' || i, 'race-' || lpad(i::text, 2, '0') from generate_series(1, 55) i;
        insert into clubs (name, slug) values ('Race X', 'race-x'), ('Race Y', 'race-y');" >/dev/null
  echo "different clubs: $(race race-x race-y)"
  echo "same club:       $(race race-x race-x)"
}

status=0
echo "== with the migration as drafted"
out=$(run_against "$MIGRATION"); echo "$out" | sed 's/^/   /'
diff_line=$(echo "$out" | grep "^different"); same_line=$(echo "$out" | grep "^same")
IFS='|' read -r cnt ans wait_ms <<< "$(echo "$diff_line" | sed 's/^[^:]*: *//')"
if [ "$cnt" = 50 ] && [ "$ans" = too_many_favourites ] && [ "${wait_ms:-0}" -ge 900 ]; then
  echo "   ok   two sessions adding the 50th and 51st at once: 50 kept, the second refused after waiting ${wait_ms} ms"
else echo "   FAIL different clubs: count=$cnt answer=$ans waited=${wait_ms}ms (expected 50, too_many_favourites, waited)"; status=1; fi
IFS='|' read -r cnt ans wait_ms <<< "$(echo "$same_line" | sed 's/^[^:]*: *//')"
if [ "$cnt" = 50 ] && [ "$ans" = true ]; then
  echo "   ok   two sessions adding the same 50th club at once: one row, both succeed"
else echo "   FAIL same club: count=$cnt answer=$ans (expected 50, true)"; status=1; fi

echo "== control: the same race without the per-player lock must break the cap"
tmp=$(mktemp -d); chmod 755 "$tmp"
sed '/perform 1 from profiles where id = me for update;/d' "$MIGRATION" > "$tmp/nolock.sql"; chmod 644 "$tmp/nolock.sql"
if cmp -s "$MIGRATION" "$tmp/nolock.sql"; then echo "   FAIL could not remove the lock line from the migration"; status=1
else
  out=$(run_against "$tmp/nolock.sql"); echo "$out" | sed 's/^/   /'
  IFS='|' read -r cnt ans _ <<< "$(echo "$out" | grep "^different" | sed 's/^[^:]*: *//')"
  if [ "$cnt" = 51 ]; then echo "   ok   without the lock the cap is exceeded (51): the race is real and this test sees it"
  else echo "   FAIL without the lock the count was $cnt — the test did not reproduce the race"; status=1; fi
fi
rm -rf "$tmp"
cleanup
left=$($PSQL -At -d postgres -c "select count(*) from pg_database where datname = '$DB'")
echo "== scratch database removed: $([ "$left" = 0 ] && echo yes || echo NO)"; [ "$left" = 0 ] || status=1
[ $status = 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"
exit $status
