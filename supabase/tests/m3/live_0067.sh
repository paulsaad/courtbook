#!/usr/bin/env bash
# Tests the 0067 deployment pack (supabase/live/0067_*.sql) on LOCAL disposable databases only:
# a 0001–0071 build of origin/main (what staging has today) and a build of this checkout (with 0067).
#   PSQL="sudo -u postgres psql" bash supabase/tests/m3/live_0067.sh
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
OLD=courtbook_m67_old; NEW=courtbook_m67_new; AP=courtbook_m67_ap; X=courtbook_m67_x
BASE=${BASE:-cd5eb3a}  # origin/main at 0001-0071 when this pack was rehearsed; main has moved on
oks=0; fails=0
rep() { if [ "$2" = true ]; then echo "ok    $1"; oks=$((oks+1)); else echo "FAIL  $1  [$3]"; fails=$((fails+1)); fi; }
copy() { $PSQL -q -d postgres -c "drop database if exists $2" -c "create database $2 template $1" >/dev/null; }
fp() { $PSQL -At -d $1 -f supabase/tests/schema_fingerprint.sql; }
pf1() { $PSQL -X -At -d $1 -f supabase/live/0067_preflight.sql | awk -F'|' '$1 == 1 && $3 != "t" {print $2}' | tr '\n' ';'; }
post() { $PSQL -X -At -d $1 -f supabase/live/0067_postcheck.sql | awk -F'|' '$2 != "t" {print $1}' | tr '\n' ';'; }

PSQL="$PSQL" DB=$OLD bash supabase/tests/audit/build_db.sh "$BASE" || exit 2
PSQL="$PSQL" DB=$NEW bash supabase/tests/audit/build_db.sh WORKTREE || exit 2

gen=$(mktemp -d); chmod 755 "$gen"; OUT=$gen bash supabase/live/make_0067_apply.sh >/dev/null
rep "L1 0067_apply.sql is in sync with the migration file" "$(cmp -s "$gen/0067_apply.sql" supabase/live/0067_apply.sql && echo true)" "run make_0067_apply.sh"
rm -rf "$gen"

p=$(pf1 $OLD); rep "L2 preflight part 1 all ok on 0001–0071 ($BASE)" "$([ -z "$p" ] && echo true)" "$p"
p=$(pf1 $NEW); rep "L3 preflight refuses a database that already has 0067" "$(echo "$p" | grep -q "no function match_detail yet" && echo true)" "$p"
info=$($PSQL -X -At -d $OLD -f supabase/live/0067_preflight.sql | awk -F'|' '$1 == 2 {print $4}')
echo "      part 2 (information): statement timeout for signed-in users = $info"
w=$($PSQL -X -At -d $OLD -c "set default_transaction_read_only = on" -f supabase/live/0067_preflight.sql 2>&1 | grep -c ERROR)
rep "L4 preflight and postcheck run in a read-only session" "$([ "$w" = 0 ] && [ "$($PSQL -X -At -d $NEW -c "set default_transaction_read_only = on" -f supabase/live/0067_postcheck.sql 2>&1 | grep -c ERROR)" = 0 ] && echo true)" "errors: $w"

# live path: the SQL Editor script
copy $OLD $AP
r=$($PSQL -X -At -d $AP -f supabase/live/0067_apply.sql 2>&1 | tail -1)
rep "L5 0067_apply.sql applies on 0001–0071" "$([ "$r" = "0067 applied" ] && echo true)" "$r"
p=$(post $AP); rep "L6 postcheck all ok after it" "$([ -z "$p" ] && echo true)" "$p"
r=$($PSQL -X -At -d $AP -f supabase/live/0067_apply.sql 2>&1 | grep -o "STOPPED, nothing changed" | head -1)
rep "L7 a second run stops and changes nothing" "$([ -n "$r" ] && echo true)" "$r"
# reference: 0001–0071 plus the migration file itself (the folder may hold later candidates, e.g. 0072)
copy $OLD $X; $PSQL -X -q -d $X -v ON_ERROR_STOP=1 -1 -f supabase/migrations/0067_match_detail.sql >/dev/null 2>&1
rep "L8 result identical to applying the migration file (schema fingerprint)" "$(cmp -s <(fp $AP) <(fp $X) && echo true)" "$(diff <(fp $X) <(fp $AP) | head -2 | tr '\n' ' ')"

# staging path: the workflow applies the migration file itself
copy $OLD $X
$PSQL -X -q -d $X -v ON_ERROR_STOP=1 -1 -f supabase/migrations/0067_match_detail.sql >/dev/null 2>&1
p=$(post $X); rep "L9 staging path (migration file, as the workflow's apply runs it): postcheck all ok" "$([ -z "$p" ] && echo true)" "$p"

# rollback
copy $AP $X
$PSQL -X -q -d $X -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
insert into auth.users (id, email) values ('e6700000-0000-4000-8000-000000000001', 'l10@m67.test');
insert into matches (club_id, sport, organizer_id, start_at, players_needed, court_lost_at)
select id, 'padel', 'e6700000-0000-4000-8000-000000000001', now() + interval '3 days', 4, now() from clubs limit 1;
SQL
r=$($PSQL -X -At -d $X -f supabase/live/0067_rollback.sql 2>&1 | grep -o "STOPPED, nothing changed: some games" | head -1)
rep "L10 rollback refuses while a game uses the court-lost state" "$([ -n "$r" ] && echo true)" "$r"
copy $AP $X
$PSQL -X -q -d $X -v ON_ERROR_STOP=1 -1 -f supabase/migrations/0072_game_hardening.sql >/dev/null 2>&1
r=$($PSQL -X -At -d $X -f supabase/live/0067_rollback.sql 2>&1 | grep -o "STOPPED, nothing changed: M3-H" | head -1)
rep "L11 rollback refuses once M3-H is applied" "$([ -n "$r" ] && echo true)" "$r"
r=$($PSQL -X -At -d $AP -f supabase/live/0067_rollback.sql 2>&1 | tail -1)
rep "L12 rollback applies" "$([ "$r" = "0067 rolled back" ] && echo true)" "$r"
rep "L13 rollback restores the 0001–0071 schema exactly" "$(cmp -s <(fp $AP) <(fp $OLD) && echo true)" "$(diff <(fp $OLD) <(fp $AP) | head -2 | tr '\n' ' ')"
p=$(pf1 $AP); rep "L14 after rollback the preflight is all ok again" "$([ -z "$p" ] && echo true)" "$p"
r=$($PSQL -X -At -d $AP -f supabase/live/0067_apply.sql 2>&1 | tail -1)
rep "L15 and 0067 can be applied again" "$([ "$r" = "0067 applied" ] && echo true)" "$r"

for d in $OLD $NEW $AP $X; do $PSQL -q -d postgres -c "drop database if exists $d" >/dev/null; done
echo; echo "summary: $oks ok, $fails FAIL"
[ $fails = 0 ] && echo "RESULT: PASS" || { echo "RESULT: FAIL"; exit 1; }
