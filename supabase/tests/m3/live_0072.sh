#!/usr/bin/env bash
# Tests the 0072 deployment pack (supabase/live/0072_*.sql) on LOCAL disposable databases only: a build
# of origin/main (0001–0071) plus 0067 — what staging has today — and copies of it.
#   PSQL="sudo -u postgres psql" bash supabase/tests/m3/live_0072.sh
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
OLD=courtbook_m72_old; REF=courtbook_m72_ref; AP=courtbook_m72_ap; X=courtbook_m72_x
BASE=${BASE:-origin/main}
oks=0; fails=0
rep() { if [ "$2" = true ]; then echo "ok    $1"; oks=$((oks+1)); else echo "FAIL  $1  [$3]"; fails=$((fails+1)); fi; }
copy() { $PSQL -q -d postgres -c "drop database if exists $2" -c "create database $2 template $1" >/dev/null; }
fp() { $PSQL -At -d $1 -f supabase/tests/schema_fingerprint.sql; }
pf1() { $PSQL -X -At -d $1 -f supabase/live/0072_preflight.sql | awk -F'|' '$1 == 1 && $3 != "t" {print $2}' | tr '\n' ';'; }
post() { $PSQL -X -At -d $1 -f supabase/live/0072_postcheck.sql | awk -F'|' '$2 != "t" {print $1}' | tr '\n' ';'; }
run() { $PSQL -X -At -d $1 -f "$2" 2>&1; }

PSQL="$PSQL" DB=$OLD bash supabase/tests/audit/build_db.sh "$BASE" >/dev/null || exit 2
$PSQL -X -q -d $OLD -v ON_ERROR_STOP=1 -1 -f supabase/migrations/0067_match_detail.sql >/dev/null || exit 2
copy $OLD $REF; $PSQL -X -q -d $REF -v ON_ERROR_STOP=1 -1 -f supabase/migrations/0072_game_hardening.sql >/dev/null 2>&1

gen=$(mktemp -d); chmod 755 "$gen"; OUT=$gen bash supabase/live/make_0072_apply.sh >/dev/null
rep "L1 0072_apply.sql is in sync with the migration file" "$(cmp -s "$gen/0072_apply.sql" supabase/live/0072_apply.sql && echo true)" "run make_0072_apply.sh"
rm -rf "$gen"

p=$(pf1 $OLD); rep "L2 preflight part 1 all ok on 0001–0071 + 0067 (staging's state)" "$([ -z "$p" ] && echo true)" "$p"
echo "      part 2 (information): $($PSQL -X -At -d $OLD -f supabase/live/0072_preflight.sql | awk -F'|' '$1 == 2 {printf "%s = %s; ", $2, $4}')"
p=$(pf1 $REF); rep "L3 preflight refuses a database that already has 0072" "$(echo "$p" | grep -q "none of 0072" && echo true)" "$p"
w=$( { $PSQL -X -At -d $OLD -c "set default_transaction_read_only = on" -f supabase/live/0072_preflight.sql; $PSQL -X -At -d $REF -c "set default_transaction_read_only = on" -f supabase/live/0072_postcheck.sql; } 2>&1 | grep -c ERROR)
rep "L4 preflight and postcheck run in a read-only session" "$([ "$w" = 0 ] && echo true)" "errors: $w"

p=$(post $REF); rep "L5 staging path (migration file, as the workflow's apply runs it): postcheck all ok" "$([ -z "$p" ] && echo true)" "$p"

copy $OLD $AP
r=$(run $AP supabase/live/0072_apply.sql | tail -1); rep "L6 0072_apply.sql applies on staging's state" "$([ "$r" = "0072 applied" ] && echo true)" "$r"
p=$(post $AP); rep "L7 postcheck all ok after it" "$([ -z "$p" ] && echo true)" "$p"
r=$(run $AP supabase/live/0072_apply.sql | grep -o "STOPPED, nothing changed" | head -1); rep "L8 a second run stops and changes nothing" "$([ -n "$r" ] && echo true)" "$r"
rep "L9 result identical to applying the migration file (schema fingerprint)" "$(cmp -s <(fp $AP) <(fp $REF) && echo true)" "$(diff <(fp $REF) <(fp $AP) | head -2 | tr '\n' ' ')"

copy $AP $X
$PSQL -X -q -d $X -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
insert into auth.users (id, email) values ('e7200000-0000-4000-8000-000000000001', 'l10@m72.test');
insert into matches (club_id, sport, organizer_id, start_at, players_needed, status, closed_reason, court_lost_at)
select id, 'padel', 'e7200000-0000-4000-8000-000000000001', now() + interval '3 days', 4, 'closed', 'no_court', now() from clubs limit 1;
SQL
r=$(run $X supabase/live/0072_rollback.sql | grep -o "STOPPED, nothing changed: some games" | head -1)
rep "L10 rollback refuses while a game waits for its organiser after a cancelled court booking" "$([ -n "$r" ] && echo true)" "$r"
r=$(run $OLD supabase/live/0072_rollback.sql | grep -o "STOPPED, nothing changed: this database" | head -1)
rep "L11 rollback refuses a database without 0072" "$([ -n "$r" ] && echo true)" "$r"

r=$(run $AP supabase/live/0072_rollback.sql | tail -1); rep "L12 rollback applies" "$([ "$r" = "0072 rolled back" ] && echo true)" "$r"
rep "L13 rollback restores the 0001–0071 + 0067 schema exactly (functions, grants, triggers)" "$(cmp -s <(fp $AP) <(fp $OLD) && echo true)" "$(diff <(fp $OLD) <(fp $AP) | head -3 | tr '\n' ' ')"
p=$(pf1 $AP); rep "L14 after rollback the preflight is all ok again" "$([ -z "$p" ] && echo true)" "$p"
r=$(run $AP supabase/live/0072_apply.sql | tail -1); rep "L15 and 0072 can be applied again" "$([ "$r" = "0072 applied" ] && echo true)" "$r"

for d in $OLD $REF $AP $X; do $PSQL -q -d postgres -c "drop database if exists $d" >/dev/null; done
echo; echo "summary: $oks ok, $fails FAIL"
[ $fails = 0 ] && echo "RESULT: PASS" || { echo "RESULT: FAIL"; exit 1; }
