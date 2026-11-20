#!/usr/bin/env bash
# Tests Package 3 (supabase/live/pkg3_*.sql: 0074 + 0075 in one transaction) on LOCAL disposable databases
# only: a build of main before the M3 merge (cd5eb3a, 0001–0071) + 0067, 0072, 0073 (= live after package 1) with live-like games
# and chat, and copies of it.
#   PSQL="sudo -u postgres psql" bash supabase/tests/m3/live_package3.sh
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
OLD=courtbook_p3_old; REF=courtbook_p3_ref; AP=courtbook_p3_ap; X=courtbook_p3_x
BASE=${BASE:-cd5eb3a19598c8345ab958f8f5448beec3b35a24}   # main before the M3 merge = 0001–0071
oks=0; fails=0
rep() { if [ "$2" = true ]; then echo "ok    $1"; oks=$((oks+1)); else echo "FAIL  $1  [$3]"; fails=$((fails+1)); fi; }
copy() { $PSQL -q -d postgres -c "drop database if exists $2" -c "create database $2 template $1" >/dev/null; }
fp() { $PSQL -At -d $1 -f supabase/tests/schema_fingerprint.sql; }
pf1() { $PSQL -X -At -d $1 -f supabase/live/pkg3_preflight.sql 2>&1 | awk -F'|' '($1 == 1 && $3 != "t") || /ERROR/ {print $2 $0}' | tr '\n' ';'; }
post() { $PSQL -X -At -d $1 -f supabase/live/pkg3_postcheck.sql 2>&1 | awk -F'|' '$2 != "t" {print $1}' | tr '\n' ';'; }
sqled() { $PSQL -X -At -d $1 -c "$(cat "$2")" 2>&1; }
data() { $PSQL -At -d $1 -c "select (select count(*) from matches) || '/' || (select count(*) from match_players) || '/' || (select count(*) from match_messages) || '/' || (select count(*) from notifications) || '/' || (select count(*) from profiles) || '/' || (select md5(string_agg(id::text || status, ',' order by id)) from matches)"; }

PSQL="$PSQL" DB=$OLD bash supabase/tests/audit/build_db.sh "$BASE" >/dev/null || exit 2
for m in 0067_match_detail 0072_game_hardening 0073_post_match_token; do $PSQL -X -q -d $OLD -v ON_ERROR_STOP=1 -1 -f supabase/migrations/$m.sql >/dev/null 2>&1 || { echo "base build failed at $m"; exit 2; }; done
$PSQL -X -q -d $OLD -v ON_ERROR_STOP=1 >/dev/null <<'SQL' || exit 2
insert into auth.users (id, email) values ('e7500000-0000-4000-8000-000000000001', 'org@p3.test'), ('e7500000-0000-4000-8000-000000000002', 'pl@p3.test') on conflict do nothing;
insert into matches (club_id, sport, organizer_id, start_at, end_at, players_needed, status)
select c.id, 'padel', 'e7500000-0000-4000-8000-000000000001', now() + (g || ' days')::interval, now() + (g || ' days')::interval + interval '90 minutes', 3, 'open'
from (select id from clubs order by slug limit 1) c, generate_series(1, 4) g;
insert into match_players (match_id, profile_id, status)
select id, 'e7500000-0000-4000-8000-000000000002', 'accepted' from matches where organizer_id = 'e7500000-0000-4000-8000-000000000001' limit 2;
insert into match_messages (match_id, profile_id, body)
select id, 'e7500000-0000-4000-8000-000000000001', 'see you there' from matches where organizer_id = 'e7500000-0000-4000-8000-000000000001' limit 1;
SQL
copy $OLD $REF
for m in 0074_safety 0075_report_history; do $PSQL -X -q -d $REF -v ON_ERROR_STOP=1 -1 -f supabase/migrations/$m.sql >/dev/null 2>&1 || echo "reference build failed at $m"; done

gen=$(mktemp -d); chmod 755 "$gen"; OUT=$gen bash supabase/live/make_package3.sh
rep "Q1 pkg3_apply.sql is in sync with its sources (make_package3.sh)" "$(cmp -s "$gen/pkg3_apply.sql" supabase/live/pkg3_apply.sql && echo true)" "run make_package3.sh"
rm -rf "$gen"
w=$( { $PSQL -X -At -d $OLD -c "set default_transaction_read_only = on" -f supabase/live/pkg3_preflight.sql; $PSQL -X -At -d $REF -c "set default_transaction_read_only = on" -f supabase/live/pkg3_postcheck.sql; } 2>&1 | grep -c ERROR)
rep "Q2 preflight and postcheck run in a read-only session" "$([ "$w" = 0 ] && echo true)" "errors: $w"
p=$(pf1 $OLD); rep "Q3 preflight part 1 all ok on live's state (0001–0073)" "$([ -z "$p" ] && echo true)" "$p"
echo "      rows: $($PSQL -X -At -d $OLD -f supabase/live/pkg3_preflight.sql | awk -F'|' '{n[$1]++} END {printf "part 1 = %d, part 2 = %d", n[1], n[2]}'); part 2: $($PSQL -X -At -d $OLD -f supabase/live/pkg3_preflight.sql | awk -F'|' '$1 == 2 {printf "%s = %s; ", $2, $4}')"
p=$(pf1 $REF); rep "Q4 preflight refuses a database that already has the package" "$([ -n "$p" ] && echo true)" "$p"
p=$(post $REF); rep "Q5 postcheck all ok on the reference (migration files in order, as staging)" "$([ -z "$p" ] && echo true)" "$p"
p=$(post $OLD); rep "Q6 postcheck is not ok before the package" "$([ -n "$p" ] && echo true)" "$p"

before=$(data $OLD)
copy $OLD $AP
r=$(sqled $AP supabase/live/pkg3_apply.sql | tail -1); rep "Q7 pkg3_apply.sql applies on live's state (one query string, as the SQL Editor)" "$([ "$r" = "package 3 applied: 0074, 0075" ] && echo true)" "$r"
p=$(post $AP); rep "Q8 postcheck all ok after it" "$([ -z "$p" ] && echo true)" "$p"
rep "Q9 result identical to the two migration files applied in order (schema fingerprint)" "$(cmp -s <(fp $AP) <(fp $REF) && echo true)" "$(diff <(fp $REF) <(fp $AP) | head -2 | tr '\n' ' ')"
rep "Q10 existing games, players, chat, notices and profiles unchanged" "$([ "$(data $AP)" = "$before" ] && echo true)" "$(data $AP) vs $before"
rep "Q11 the blocked-word list is empty" "$([ "$($PSQL -At -d $AP -c 'select count(*) from blocked_terms')" = 0 ] && echo true)" ""
r=$(sqled $AP supabase/live/pkg3_apply.sql | grep -o "STOPPED, nothing changed" | head -1); rep "Q12 a second run stops and changes nothing" "$([ -n "$r" ] && cmp -s <(fp $AP) <(fp $REF) && echo true)" "$r"

# all or nothing: make 0075's start check fail (function already there); 0074 must be rolled back with it
copy $OLD $X
$PSQL -X -q -d $X -c "create function admin_blocks_received(p uuid[]) returns int language sql as 'select 1'" >/dev/null
fx=$(fp $X)
r=$(sqled $X supabase/live/pkg3_apply.sql | grep -o "STOPPED, nothing changed: not the verified 0074 starting point for 0075" | head -1)
rep "Q13 when 0075's start check fails, the package stops ... and 0074 is rolled back too" "$([ -n "$r" ] && cmp -s <(fp $X) <(echo "$fx") && echo true)" "$r"
copy $OLD $X
sed 's/cab286a9d0ff32a9a39a31452a9ad639/00000000000000000000000000000000/' supabase/live/pkg3_apply.sql > /tmp/p3_bad.sql
r=$(sqled $X /tmp/p3_bad.sql | grep -o "ROLLED BACK: the result of 0075" | head -1)
rep "Q14 when a result check fails (control: wrong 0075 fingerprint), everything is rolled back" "$([ -n "$r" ] && cmp -s <(fp $X) <(fp $OLD) && echo true)" "$r"
sed 's/65b3a0d219612205d3ceacb6d2f55292/00000000000000000000000000000000/' supabase/live/pkg3_apply.sql > /tmp/p3_bad.sql
r=$(sqled $X /tmp/p3_bad.sql | grep -o "ROLLED BACK: the result of 0074" | head -1)
rep "Q15 control: a wrong 0074 result also rolls everything back" "$([ -n "$r" ] && cmp -s <(fp $X) <(fp $OLD) && echo true)" "$r"
rm -f /tmp/p3_bad.sql

# rollback newest first: 0075, then 0074 (0074's rollback keeps its tables and data, by design)
r1=$($PSQL -X -At -d $AP -f supabase/live/0075_rollback.sql 2>&1 | tail -1)
r2=$($PSQL -X -At -d $AP -f supabase/live/0074_rollback.sql 2>&1 | grep -ci "error")
rep "Q16 rollback 0075 → 0074 runs" "$([ "$r2" = 0 ] && echo true)" "$r1 / errors $r2"
p=$($PSQL -X -At -d $AP -f supabase/live/pkg3_preflight.sql | awk -F'|' '$1 == 1 && $3 != "t" {print $2}' | tr '\n' ';')
rep "Q17 ... every function and the chat policy are back to the 0073 versions (only 'tables' and 'rules_accepted_at' remain, kept by design)" "$(echo "$p" | grep -v "function\|policy\|version" >/dev/null; [ "$(echo "$p" | tr ';' '\n' | grep -c .)" = 2 ] && echo "$p" | grep -q "tables" && echo "$p" | grep -q "rules_accepted_at" && echo true)" "$p"
rep "Q18 ... with games, players, chat, notices and profiles unchanged" "$([ "$(data $AP)" = "$before" ] && echo true)" "$(data $AP)"

for d in $OLD $REF $AP $X; do $PSQL -q -d postgres -c "drop database if exists $d" >/dev/null; done
echo; echo "summary: $oks ok, $fails FAIL"
[ $fails = 0 ] && echo "RESULT: PASS" || { echo "RESULT: FAIL"; exit 1; }
