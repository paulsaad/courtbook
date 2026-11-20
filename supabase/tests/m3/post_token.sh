#!/usr/bin/env bash
# 0073 (post_match idempotency key): tests, a two-session race with one key, and mutation checks.
# LOCAL DISPOSABLE REPLICA ONLY (courtbook_test); the tests run in a transaction that is rolled back;
# the race runs on a throwaway copy.
#   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh
#   PSQL="sudo -u postgres psql" bash supabase/tests/m3/post_token.sh
PSQL=${PSQL:-psql}
DB=courtbook_test
MIGRATION=${MIGRATION:-supabase/migrations/0073_post_match_token.sql}
TESTS=supabase/tests/m3/post_token_tests.sql
where=$($PSQL -At -d $DB -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;;
  *) echo "refusing: connected to '$where', expected the local courtbook_test replica"; exit 2;; esac
fp() { $PSQL -At -d $DB -c "select md5(string_agg(p.proname || pg_get_functiondef(p.oid), '' order by p.proname, p.oid)) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'"; }
before=$(fp)
run() { $PSQL -d $DB -X -q -At -v mig="$1" -f $TESTS 2>&1; }
status=0
echo "== 0073 tests"
out=$(run "$MIGRATION"); echo "$out" | grep -E "^(FAIL|ERROR|psql)" || true
summary=$(echo "$out" | grep -E "^FAILED " | tail -1); oks=$(echo "$out" | grep -c "^ok ")
echo "   $oks checks passed; ${summary:-no summary (the run stopped)}"; [ "$summary" = "FAILED 0 of $oks" ] || status=1

echo "== race: two sessions post with the same key at the same moment"
RACE=courtbook_0073_race; W=$(mktemp -d); chmod 755 "$W"
race() {   # $1 migration variant → prints "<games made> <second session's answer>"
  $PSQL -q -d postgres -c "drop database if exists $RACE" -c "create database $RACE template $DB" >/dev/null
  $PSQL -X -q -d $RACE -c "drop function if exists post_match(uuid, sport, timestamptz, timestamptz, int, int, int, text, uuid, text, uuid); drop index if exists matches_organizer_client_token; alter table matches drop column if exists client_token" >/dev/null
  $PSQL -X -q -d $RACE -v ON_ERROR_STOP=1 -f "$1" >/dev/null 2>&1 || { echo "cannot-apply"; return; }
  $PSQL -X -q -d $RACE -c "insert into auth.users (id, email) values ('e3000000-0000-4000-8000-0000000000aa', 'race@0073.test')" >/dev/null
  local q="set local role authenticated; select set_config('request.jwt.claim.sub', 'e3000000-0000-4000-8000-0000000000aa', true); select post_match((select id from clubs where slug = 'batroun'), 'padel', now() + interval '44 days', null, null, null, 3, null, null, 'open', 'a0000000-0000-4000-8000-0000000000ee');"
  ( $PSQL -X -q -At -d $RACE -c "begin" -c "$q" -c "select pg_sleep(2)" -c "commit" >$W/a.out 2>&1 ) &
  sleep 0.5
  $PSQL -X -q -At -d $RACE -c "begin" -c "$q" -c "commit" >$W/b.out 2>&1; wait
  echo "$($PSQL -X -At -d $RACE -c "select count(*) from matches where organizer_id = 'e3000000-0000-4000-8000-0000000000aa'") $(grep -oE '^[0-9a-f-]{36}$|booking_already_posted' $W/b.out | tail -1)"
}
expect() { if [ "$2" = "$3" ]; then echo "   ok    $1"; else echo "   FAIL  $1 — got: $2"; status=1; fi; }
r=$(race "$MIGRATION"); expect "one game for two simultaneous posts with one key; both get it" "${r%% *} $([ -n "${r#* }" ] && echo answered)" "1 answered"
nolock=$W/nolock.sql; sed -e 's/  perform pg_advisory_xact_lock.*$//' "$MIGRATION" > "$nolock"; chmod 644 "$nolock"
r=$(race "$nolock"); expect "without the lock, the unique index still makes one game and the second post gets it back" "${r%% *} $(echo "${r#* }" | grep -qE '^[0-9a-f-]{36}$' && echo uuid)" "1 uuid"
q3=$W/q3.sql; sed -e "s/  if v_constraint = 'matches_organizer_client_token' then/  if false then/" "$nolock" > "$q3"; chmod 644 "$q3"
r=$(race "$q3"); expect "mutant Q3 (key collision read as booking_already_posted) is caught by the same race" "${r#* }" "booking_already_posted"
ctl=$W/control.sql; sed -e 's/^create unique index if not exists matches_organizer_client_token.*$//' -e 's/    if v_existing is not null then return v_existing; end if;//' "$nolock" > "$ctl"; chmod 644 "$ctl"
r=$(race "$ctl"); expect "control: without lock, index and lookups, the same race makes 2 games" "${r%% *}" "2"
$PSQL -q -d postgres -c "drop database if exists $RACE" >/dev/null

echo "== mutation checks"
mutants=(
  "Q1 no lookup before the rules|0,/    if v_existing is not null then return v_existing; end if;/s//    null;/"
  "Q2 key not stored|s/p_booking, p_join_mode, p_token);/p_booking, p_join_mode, null);/"
  "Q4 key global, not per organiser|s/where organizer_id = auth.uid() and client_token = p_token/where client_token = p_token/g"
  "Q5 old ten-argument function kept|s/^drop function if exists post_match(uuid, sport, timestamptz, timestamptz, int, int, int, text, uuid, text);//"
)
for m in "${mutants[@]}"; do
  name=${m%%|*}; expr=${m#*|}
  sed "$expr" "$MIGRATION" > "$W/mutant.sql"; chmod 644 "$W/mutant.sql"
  if cmp -s "$MIGRATION" "$W/mutant.sql"; then echo "   $name: NOT APPLIED — fix the mutant"; status=1; continue; fi
  msum=$(run "$W/mutant.sql" | grep -E "^FAILED " | tail -1)
  if [ -z "$msum" ] || [ "${msum#FAILED 0 }" = "$msum" ]; then echo "   $name: detected (${msum:-run stopped})"; else echo "   $name: NOT DETECTED"; status=1; fi
done
rm -rf "$W"
[ "$(fp)" = "$before" ] && echo "== replica unchanged" || { echo "== REPLICA CHANGED"; status=1; }
[ $status = 0 ] && echo "RESULT: PASS" || { echo "RESULT: FAIL"; exit 1; }
