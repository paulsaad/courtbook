#!/usr/bin/env bash
# 0073 staging/live pack rehearsal on a throwaway copy of the local replica: preflight (all true) →
# apply → preflight (refuses) → postcheck (all true) → rollback → preflight (all true again) → rollback
# again (refuses). LOCAL ONLY.  PSQL="sudo -u postgres psql" bash supabase/tests/m3/live_0073.sh
PSQL=${PSQL:-psql}; SRC=courtbook_test; DB=courtbook_0073_live
P() { $PSQL -X -q -At -F'|' -d $DB "$@"; }
fails=0; rep() { if [ "$2" = true ]; then echo "ok    $1"; else echo "FAIL  $1  [$3]"; fails=$((fails+1)); fi; }
$PSQL -q -d postgres -c "drop database if exists $DB" -c "create database $DB template $SRC" >/dev/null 2>&1
# the state 0073 is applied to: 0072's post_match, no key
P -c "drop function if exists post_match(uuid, sport, timestamptz, timestamptz, int, int, int, text, uuid, text, uuid); drop index if exists matches_organizer_client_token; alter table matches drop column if exists client_token;"
P -f supabase/migrations/0072_game_hardening.sql >/dev/null 2>&1
P -c "grant execute on function post_match(uuid, sport, timestamptz, timestamptz, int, int, int, text, uuid, text) to authenticated, service_role"
allp1() { P -f supabase/live/0073_preflight.sql | awk -F'|' '$1==1 && $3!="t"' | wc -l; }
rep "L1 preflight on the 0072 state: all part-1 true" "$([ "$(allp1)" = 0 ] && echo true)" "$(allp1) false"
P -v ON_ERROR_STOP=1 -1 -f supabase/migrations/0073_post_match_token.sql >/dev/null 2>&1; rep "L2 0073 applies" "$([ $? = 0 ] && echo true)"
rep "L3 preflight after 0073 refuses (three rows false)" "$([ "$(allp1)" = 3 ] && echo true)" "$(allp1)"
n=$(P -f supabase/live/0073_postcheck.sql | awk -F'|' '$2!="t"' | wc -l); rep "L4 postcheck: all true" "$([ "$n" = 0 ] && echo true)" "$n false"
P -v ON_ERROR_STOP=1 -f supabase/live/0073_rollback.sql >/dev/null 2>&1; rep "L5 rollback runs" "$([ $? = 0 ] && echo true)"
rep "L6 preflight after rollback: all part-1 true (back to 0072)" "$([ "$(allp1)" = 0 ] && echo true)" "$(allp1) false"
P -v ON_ERROR_STOP=1 -f supabase/live/0073_rollback.sql >/dev/null 2>&1; rep "L7 a second rollback refuses" "$([ $? != 0 ] && echo true)"
P -v ON_ERROR_STOP=1 -1 -f supabase/migrations/0073_post_match_token.sql >/dev/null 2>&1; rep "L8 0073 applies again after the rollback" "$([ $? = 0 ] && echo true)"
$PSQL -q -d postgres -c "drop database if exists $DB" >/dev/null
echo "summary: $((8-fails)) ok, $fails FAIL"; [ $fails = 0 ] && echo "RESULT: PASS" || { echo "RESULT: FAIL"; exit 1; }
