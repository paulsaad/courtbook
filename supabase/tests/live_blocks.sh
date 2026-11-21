#!/usr/bin/env bash
# Tests the 0076/0077 deployment files (supabase/live/007[67]_*.sql) on LOCAL disposable databases only:
# a build of origin/main (0001–0075, what live and staging have today) with some saved blocks, and copies.
#   PSQL="sudo -u postgres psql" bash supabase/tests/live_blocks.sh
set -u
cd "$(dirname "$0")/../.."
PSQL=${PSQL:-psql}
OLD=courtbook_lb_old; RA=courtbook_lb_ra; RB=courtbook_lb_rb; AP=courtbook_lb_ap
BASE=${BASE:-origin/main}
oks=0; fails=0
rep() { if [ "$2" = true ]; then echo "ok    $1"; oks=$((oks+1)); else echo "FAIL  $1  [$3]"; fails=$((fails+1)); fi; }
copy() { $PSQL -q -d postgres -c "drop database if exists $2" -c "create database $2 template $1" >/dev/null; }
fp() { $PSQL -At -d $1 -f supabase/tests/schema_fingerprint.sql; }
rowsfp() { $PSQL -At -d $1 -c "select count(*) || ':' || md5(string_agg(b::text, ',' order by id)) from blocks b"; }
# a check file that errors counts as failed, never as "nothing refused"
pf1() { local o; o=$($PSQL -X -At -d $1 -f "$2" 2>&1); echo "$o" | grep -q ERROR && { echo "ERROR in $2"; return; }; echo "$o" | awk -F'|' '$1 == 1 && $3 != "t" {print $2}' | tr '\n' ';'; }
post() { local o; o=$($PSQL -X -At -d $1 -f "$2" 2>&1); echo "$o" | grep -q ERROR && { echo "ERROR in $2"; return; }; echo "$o" | awk -F'|' '$2 != "t" {print $1}' | tr '\n' ';'; }
run() { $PSQL -X -At -d $1 -f "$2" 2>&1; }
mig() { $PSQL -X -q -d $1 -v ON_ERROR_STOP=1 -1 -f "$2" >/dev/null 2>&1; }

PSQL="$PSQL" DB=$OLD bash supabase/tests/audit/build_db.sh "$BASE" >/dev/null || exit 2
$PSQL -X -q -d $OLD -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
insert into auth.users (id, phone) values ('5b000000-0000-4000-8000-000000000001', '+96150');
insert into blocks (club_id, court_id, start_at, end_at, reason, created_by)
select c.club_id, c.id, now() + interval '5 days' + (n || ' hours')::interval, now() + interval '5 days' + (n || ' hours 50 minutes')::interval,
       'saved ' || n, '5b000000-0000-4000-8000-000000000001'
from courts c, generate_series(1, 3) n where c.name = 'Padel 1';
insert into blocks (club_id, court_id, start_at, end_at, reason, created_by)
select club_id, id, now() - interval '3 days', now() - interval '2 days', 'past', '5b000000-0000-4000-8000-000000000001' from courts where name = 'Padel 2';
SQL
copy $OLD $RA; mig $RA supabase/migrations/0076_staff_block.sql || { echo "0076 does not apply"; exit 2; }
copy $RA $RB; mig $RB supabase/migrations/0077_blocks_through_functions.sql || { echo "0077 does not apply"; exit 2; }
ROWS0=$(rowsfp $OLD)

gen=$(mktemp -d); chmod 755 "$gen"; OUT=$gen bash supabase/live/make_blocks_pack.sh >/dev/null
s=true; for f in 0076_preflight 0076_apply 0076_postcheck 0076_rollback 0077_preflight 0077_apply 0077_postcheck 0077_rollback; do cmp -s "$gen/$f.sql" supabase/live/$f.sql || s="$f"; done
rep "L1 the eight 0076/0077 files are in sync with make_blocks_pack.sh and the migrations" "$s" "run make_blocks_pack.sh ($s)"
rm -rf "$gen"

echo "--- 0076"
p=$(pf1 $OLD supabase/live/0076_preflight.sql); rep "L2 0076 preflight part 1 all ok on 0001–0075 (live and staging today)" "$([ -z "$p" ] && echo true)" "$p"
echo "      part 2 (information): $($PSQL -X -At -d $OLD -f supabase/live/0076_preflight.sql | awk -F'|' '$1 == 2 {printf "%s = %s; ", $2, $4}')"
p=$(pf1 $RA supabase/live/0076_preflight.sql); rep "L3 0076 preflight refuses a database that already has 0076" "$(echo "$p" | grep -q "none of 0076" && echo true)" "$p"
w=$( { for d_f in "$OLD 0076_preflight" "$RA 0076_postcheck" "$RA 0077_preflight" "$RB 0077_postcheck"; do set -- $d_f; $PSQL -X -At -d $1 -c "set default_transaction_read_only = on" -f supabase/live/$2.sql; done; } 2>&1 | grep -c ERROR)
rep "L4 the four preflights/postchecks run in a read-only session" "$([ "$w" = 0 ] && echo true)" "errors: $w"
p=$(post $RA supabase/live/0076_postcheck.sql); rep "L5 staging path (migration file, as the workflow's apply runs it): 0076 postcheck all ok" "$([ -z "$p" ] && echo true)" "$p"
copy $OLD $AP
r=$(run $AP supabase/live/0076_apply.sql | tail -1); rep "L6 0076_apply.sql applies on 0001–0075" "$([ "$r" = "0076 applied" ] && echo true)" "$r"
p=$(post $AP supabase/live/0076_postcheck.sql); rep "L7 0076 postcheck all ok after it" "$([ -z "$p" ] && echo true)" "$p"
r=$(run $AP supabase/live/0076_apply.sql | grep -o "STOPPED, nothing changed" | head -1); rep "L8 a second 0076 run stops and changes nothing" "$([ -n "$r" ] && echo true)" "$r"
rep "L9 result identical to applying the migration file (schema fingerprint)" "$(cmp -s <(fp $AP) <(fp $RA) && echo true)" "$(diff <(fp $RA) <(fp $AP) | head -2 | tr '\n' ' ')"
rep "L10 saved blocks unchanged by 0076 (all columns, incl. a past and off-grid ones)" "$([ "$(rowsfp $AP)" = "$ROWS0" ] && echo true)" "$(rowsfp $AP)"
r=$(run $OLD supabase/live/0077_apply.sql | grep -o "STOPPED, nothing changed" | head -1); rep "L11 0077_apply.sql refuses a database without 0076" "$([ -n "$r" ] && echo true)" "$r"

echo "--- 0077"
p=$(pf1 $AP supabase/live/0077_preflight.sql); rep "L12 0077 preflight part 1 all ok after 0076" "$([ -z "$p" ] && echo true)" "$p"
p=$(pf1 $OLD supabase/live/0077_preflight.sql); rep "L13 0077 preflight refuses 0001–0075" "$(echo "$p" | grep -q "staff_block: the verified 0076" && echo true)" "$p"
p=$(post $RB supabase/live/0077_postcheck.sql); rep "L14 staging path: 0077 postcheck all ok" "$([ -z "$p" ] && echo true)" "$p"
r=$(run $AP supabase/live/0077_apply.sql | tail -1); rep "L15 0077_apply.sql applies after 0076" "$([ "$r" = "0077 applied" ] && echo true)" "$r"
p=$(post $AP supabase/live/0077_postcheck.sql); rep "L16 0077 postcheck all ok after it" "$([ -z "$p" ] && echo true)" "$p"
r=$(run $AP supabase/live/0077_apply.sql | grep -o "STOPPED, nothing changed" | head -1); rep "L17 a second 0077 run stops" "$([ -n "$r" ] && echo true)" "$r"
rep "L18 result identical to applying the migration files" "$(cmp -s <(fp $AP) <(fp $RB) && echo true)" "$(diff <(fp $RB) <(fp $AP) | head -2 | tr '\n' ' ')"
rep "L19 saved blocks unchanged by 0077" "$([ "$(rowsfp $AP)" = "$ROWS0" ] && echo true)" "$(rowsfp $AP)"

echo "--- rollbacks"
r=$(run $AP supabase/live/0076_rollback.sql | grep -o "STOPPED, nothing changed" | head -1); rep "L20 0076 rollback refuses while 0077 is applied" "$([ -n "$r" ] && echo true)" "$r"
r=$(run $OLD supabase/live/0077_rollback.sql | grep -o "STOPPED, nothing changed" | head -1); rep "L21 0077 rollback refuses a database without 0077" "$([ -n "$r" ] && echo true)" "$r"
r=$(run $AP supabase/live/0077_rollback.sql | tail -1); rep "L22 0077 rollback applies" "$([ "$r" = "0077 rolled back" ] && echo true)" "$r"
rep "L23 0077 rollback restores the 0076 schema exactly" "$(cmp -s <(fp $AP) <(fp $RA) && echo true)" "$(diff <(fp $RA) <(fp $AP) | head -3 | tr '\n' ' ')"
r=$(run $AP supabase/live/0076_rollback.sql | tail -1); rep "L24 0076 rollback applies" "$([ "$r" = "0076 rolled back" ] && echo true)" "$r"
rep "L25 0076 rollback restores the 0001–0075 schema exactly" "$(cmp -s <(fp $AP) <(fp $OLD) && echo true)" "$(diff <(fp $OLD) <(fp $AP) | head -3 | tr '\n' ' ')"
rep "L26 saved blocks unchanged through both rollbacks" "$([ "$(rowsfp $AP)" = "$ROWS0" ] && echo true)" "$(rowsfp $AP)"
p=$(pf1 $AP supabase/live/0076_preflight.sql); rep "L27 after both rollbacks the 0076 preflight is all ok again" "$([ -z "$p" ] && echo true)" "$p"
r=$(run $AP supabase/live/0076_apply.sql | tail -1); r2=$(run $AP supabase/live/0077_apply.sql | tail -1)
rep "L28 and 0076 + 0077 can be applied again" "$([ "$r $r2" = "0076 applied 0077 applied" ] && echo true)" "$r / $r2"

for d in $OLD $RA $RB $AP; do $PSQL -q -d postgres -c "drop database if exists $d" >/dev/null; done
echo; echo "summary: $oks ok, $fails FAIL"
[ $fails = 0 ] && echo "RESULT: PASS" || { echo "RESULT: FAIL"; exit 1; }
