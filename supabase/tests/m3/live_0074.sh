#!/usr/bin/env bash
# 0074 staging/live pack rehearsal on a throwaway copy built at the 0073 state: preflight → apply →
# preflight refuses → postcheck → a block, a report and a suspension are made → rollback (data kept,
# behaviour gone) → preflight passes again except for the kept tables → re-apply → postcheck → second
# rollback refuses after re-apply only once. LOCAL ONLY.
#   PSQL="sudo -u postgres psql" bash supabase/tests/m3/live_0074.sh
PSQL=${PSQL:-psql}; DB=courtbook_0074_live
P() { $PSQL -X -q -At -F'|' -d $DB "$@"; }
fails=0; n=0; rep() { n=$((n+1)); if [ "$2" = true ]; then echo "ok    $1"; else echo "FAIL  $1  [$3]"; fails=$((fails+1)); fi; }
$PSQL -q -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null 2>&1
P -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql >/dev/null
for f in $(ls supabase/migrations/*.sql | sort | grep -v 0074_); do P -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null 2>&1 || { echo "cannot build: $f"; exit 2; }; done
false1() { P -f supabase/live/0074_preflight.sql | awk -F'|' '$1==1 && $3!="t"' | wc -l; }
rep "L1 preflight on the 0073 state: all part-1 true" "$([ "$(false1)" = 0 ] && echo true)" "$(false1) false"
P -v ON_ERROR_STOP=1 -1 -f supabase/migrations/0074_safety.sql >/dev/null 2>&1; rep "L2 0074 applies" "$([ $? = 0 ] && echo true)"
rep "L3 preflight after 0074 refuses" "$([ "$(false1)" -ge 10 ] && echo true)" "$(false1)"
pc() { P -f supabase/live/0074_postcheck.sql | awk -F'|' '$2!="t"' | wc -l; }
rep "L4 postcheck: all true" "$([ "$(pc)" = 0 ] && echo true)" "$(pc) false"
# some data, made as the database owner (the rehearsal is about the pack, not the rules)
P -c "insert into auth.users (id, email) values ('e4000000-0000-4000-8000-000000000001','l1@0074.test'), ('e4000000-0000-4000-8000-000000000002','l2@0074.test');
      insert into player_blocks values ('e4000000-0000-4000-8000-000000000001','e4000000-0000-4000-8000-000000000002');
      insert into account_suspensions (profile_id, reason) values ('e4000000-0000-4000-8000-000000000002','test');"
P -v ON_ERROR_STOP=1 -f supabase/live/0074_rollback.sql >/dev/null 2>&1; rep "L5 rollback runs" "$([ $? = 0 ] && echo true)"
rep "L6 data kept: the block and the suspension rows are still there" "$([ "$(P -c "select (select count(*) from player_blocks) || '/' || (select count(*) from account_suspensions)")" = "1/1" ] && echo true)"
rep "L7 behaviour gone: no trigger, no 0074 function" "$([ "$(P -c "select count(*) from pg_trigger where tgname = 'match_players_block_guard'")$(P -c "select count(*) from pg_proc where proname in ('assert_active','block_player','admin_reports','send_feedback','my_recent_players')")" = "00" ] && echo true)"
only_tables() { P -f supabase/live/0074_preflight.sql | awk -F'|' '$1==1 && $3!="t" {print $2}'; }
rep "L8 preflight after rollback: everything back except the kept tables and column" "$([ "$(only_tables | grep -vc "tables exists yet\|rules_accepted_at")" = 0 ] && echo true)" "$(only_tables | tr '\n' ';')"
P -v ON_ERROR_STOP=1 -f supabase/live/0074_rollback.sql >/dev/null 2>&1; rep "L9 a second rollback refuses" "$([ $? != 0 ] && echo true)"
P -v ON_ERROR_STOP=1 -1 -f supabase/migrations/0074_safety.sql >/dev/null 2>&1; rep "L10 0074 re-applies over the kept data" "$([ $? = 0 ] && echo true)"
rep "L11 postcheck after re-apply: all true" "$([ "$(pc)" = 0 ] && echo true)" "$(pc) false"
rep "L12 the kept block applies again" "$([ "$(P -c "select players_blocked('e4000000-0000-4000-8000-000000000001','e4000000-0000-4000-8000-000000000002')")" = t ] && echo true)"
$PSQL -q -d postgres -c "drop database if exists $DB" >/dev/null
echo "summary: $((n-fails)) ok, $fails FAIL"; [ $fails = 0 ] && echo "RESULT: PASS" || { echo "RESULT: FAIL"; exit 1; }
