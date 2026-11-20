#!/usr/bin/env bash
# Tests Package 1 (supabase/live/pkg1_*.sql: 0067 + 0072 + 0073 in one transaction) on LOCAL disposable
# databases only: a build of origin/main (0001–0071 = live's schema after the release fixes) with
# live-like games (4 not cancelled, players, chat), and copies of it.
#   PSQL="sudo -u postgres psql" bash supabase/tests/m3/live_package1.sh
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
OLD=courtbook_p1_old; REF=courtbook_p1_ref; AP=courtbook_p1_ap; X=courtbook_p1_x
BASE=${BASE:-origin/main}
oks=0; fails=0
rep() { if [ "$2" = true ]; then echo "ok    $1"; oks=$((oks+1)); else echo "FAIL  $1  [$3]"; fails=$((fails+1)); fi; }
copy() { $PSQL -q -d postgres -c "drop database if exists $2" -c "create database $2 template $1" >/dev/null; }
fp() { $PSQL -At -d $1 -f supabase/tests/schema_fingerprint.sql; }
pf1() { $PSQL -X -At -d $1 -f supabase/live/pkg1_preflight.sql | awk -F'|' '$1 == 1 && $3 != "t" {print $2}' | tr '\n' ';'; }
post() { $PSQL -X -At -d $1 -f supabase/live/pkg1_postcheck.sql | awk -F'|' '$2 != "t" {print $1}' | tr '\n' ';'; }
sqled() { $PSQL -X -At -d $1 -c "$(cat "$2")" 2>&1; }   # one query string, as the SQL Editor sends it
data() { $PSQL -At -d $1 -c "select (select count(*) from matches) || '/' || (select count(*) from match_players) || '/' || (select count(*) from match_messages) || '/' || (select count(*) from notifications) || '/' || (select md5(string_agg(id::text || status || coalesce(closed_reason,''), ',' order by id)) from matches)"; }

PSQL="$PSQL" DB=$OLD bash supabase/tests/audit/build_db.sh "$BASE" >/dev/null || exit 2
$PSQL -X -q -d $OLD -v ON_ERROR_STOP=1 >/dev/null <<'SQL' || exit 2
insert into auth.users (id, email) values ('e7300000-0000-4000-8000-000000000001', 'org@p1.test'), ('e7300000-0000-4000-8000-000000000002', 'pl@p1.test') on conflict do nothing;
insert into matches (club_id, sport, organizer_id, start_at, end_at, players_needed, status)
select c.id, 'padel', 'e7300000-0000-4000-8000-000000000001', now() + (g || ' days')::interval, now() + (g || ' days')::interval + interval '90 minutes', 3,
       (case when g = 4 then 'cancelled' else 'open' end)::match_status
from (select id from clubs order by slug limit 1) c, generate_series(1, 5) g;
insert into match_players (match_id, profile_id, status)
select id, 'e7300000-0000-4000-8000-000000000002', 'accepted' from matches where organizer_id = 'e7300000-0000-4000-8000-000000000001' and status = 'open' limit 2;
insert into match_messages (match_id, profile_id, body)
select id, 'e7300000-0000-4000-8000-000000000001', 'see you there' from matches where organizer_id = 'e7300000-0000-4000-8000-000000000001' and status = 'open' limit 1;
SQL
# reference: the three migration files applied in order, as staging received them
copy $OLD $REF
for m in 0067_match_detail 0072_game_hardening 0073_post_match_token; do $PSQL -X -q -d $REF -v ON_ERROR_STOP=1 -1 -f supabase/migrations/$m.sql >/dev/null 2>&1 || echo "reference build failed at $m"; done

gen=$(mktemp -d); chmod 755 "$gen"; OUT=$gen bash supabase/live/make_package1.sh
rep "P1 pkg1_apply.sql is in sync with its sources (make_package1.sh)" "$(cmp -s "$gen/pkg1_apply.sql" supabase/live/pkg1_apply.sql && echo true)" "run make_package1.sh"
rm -rf "$gen"
w=$( { $PSQL -X -At -d $OLD -c "set default_transaction_read_only = on" -f supabase/live/pkg1_preflight.sql; $PSQL -X -At -d $REF -c "set default_transaction_read_only = on" -f supabase/live/pkg1_postcheck.sql; } 2>&1 | grep -c ERROR)
rep "P2 preflight and postcheck run in a read-only session" "$([ "$w" = 0 ] && echo true)" "errors: $w"
p=$(pf1 $OLD); rep "P3 preflight part 1 all ok on live's state (0001–0071 without 0067)" "$([ -z "$p" ] && echo true)" "$p"
echo "      part 2 (information): $($PSQL -X -At -d $OLD -f supabase/live/pkg1_preflight.sql | awk -F'|' '$1 == 2 {printf "%s = %s; ", $2, $4}')"
p=$(pf1 $REF); rep "P4 preflight refuses a database that already has the package" "$([ -n "$p" ] && echo true)" "$p"
p=$(post $REF); rep "P5 postcheck all ok on the reference (migration files in order)" "$([ -z "$p" ] && echo true)" "$p"
p=$($PSQL -X -At -d $OLD -f supabase/live/pkg1_postcheck.sql 2>&1 | grep -c "ERROR\||f|")
rep "P6 postcheck is not ok before the package (error or a false row)" "$([ "$p" != 0 ] && echo true)" "$p"

before=$(data $OLD)
copy $OLD $AP
r=$(sqled $AP supabase/live/pkg1_apply.sql | tail -1); rep "P7 pkg1_apply.sql applies on live's state (one query string, as the SQL Editor)" "$([ "$r" = "package 1 applied: 0067, 0072, 0073" ] && echo true)" "$r"
p=$(post $AP); rep "P8 postcheck all ok after it" "$([ -z "$p" ] && echo true)" "$p"
rep "P9 result identical to the three migration files applied in order (schema fingerprint)" "$(cmp -s <(fp $AP) <(fp $REF) && echo true)" "$(diff <(fp $REF) <(fp $AP) | head -2 | tr '\n' ' ')"
rep "P10 existing games, players, chat and notices unchanged" "$([ "$(data $AP)" = "$before" ] && echo true)" "$(data $AP) vs $before"
r=$(sqled $AP supabase/live/pkg1_apply.sql | grep -o "STOPPED, nothing changed" | head -1); rep "P11 a second run stops and changes nothing" "$([ -n "$r" ] && echo true)" "$r"
rep "P12 ... and the schema is unchanged by that second run" "$(cmp -s <(fp $AP) <(fp $REF) && echo true)" ""

# all or nothing: make the LAST step (0073) refuse; 0067 and 0072 must be rolled back with it
copy $OLD $X
$PSQL -X -q -d $X -c "create index matches_organizer_client_token on matches (organizer_id)" >/dev/null
fx=$(fp $X)
r=$(sqled $X supabase/live/pkg1_apply.sql | grep -o "STOPPED, nothing changed: not the verified 0072 starting point for 0073" | head -1)
rep "P13 when 0073's start check fails, the package stops" "$([ -n "$r" ] && echo true)" "$r"
rep "P14 ... and 0067 and 0072 are rolled back too (schema identical to before)" "$(cmp -s <(fp $X) <(echo "$fx") && echo true)" "$(diff <(echo "$fx") <(fp $X) | head -2 | tr '\n' ' ')"
# a failing RESULT check (not a start check) also undoes everything
copy $OLD $X
sed 's/6a8feb9a5b8c59e81d8d72ac49076635/00000000000000000000000000000000/' supabase/live/pkg1_apply.sql > /tmp/p1_bad.sql
r=$(sqled $X /tmp/p1_bad.sql | grep -o "ROLLED BACK: the result of 0073" | head -1)
rep "P15 when a result check fails (control: wrong 0073 fingerprint), everything is rolled back" "$([ -n "$r" ] && cmp -s <(fp $X) <(fp $OLD) && echo true)" "$r"
rm -f /tmp/p1_bad.sql

# rollback, newest first, restores live's schema exactly
r1=$($PSQL -X -At -d $AP -f supabase/live/0073_rollback.sql 2>&1 | tail -1)
r2=$($PSQL -X -At -d $AP -f supabase/live/0072_rollback.sql 2>&1 | tail -1)
r3=$($PSQL -X -At -d $AP -f supabase/live/0067_rollback.sql 2>&1 | tail -1)
rep "P16 rollback 0073 → 0072 → 0067 runs" "$(echo "$r1|$r2|$r3" | grep -qi "error\|stopped" || echo true)" "$r1 | $r2 | $r3"
rep "P17 ... and restores live's schema exactly" "$(cmp -s <(fp $AP) <(fp $OLD) && echo true)" "$(diff <(fp $OLD) <(fp $AP) | head -3 | tr '\n' ' ')"
rep "P18 ... with games, players, chat and notices unchanged" "$([ "$(data $AP)" = "$before" ] && echo true)" "$(data $AP)"
p=$(pf1 $AP); rep "P19 after rollback the preflight is all ok again" "$([ -z "$p" ] && echo true)" "$p"
r=$(sqled $AP supabase/live/pkg1_apply.sql | tail -1); rep "P20 and the package applies again" "$([ "$r" = "package 1 applied: 0067, 0072, 0073" ] && echo true)" "$r"

for d in $OLD $REF $AP $X; do $PSQL -q -d postgres -c "drop database if exists $d" >/dev/null; done
echo; echo "summary: $oks ok, $fails FAIL"
[ $fails = 0 ] && echo "RESULT: PASS" || { echo "RESULT: FAIL"; exit 1; }
