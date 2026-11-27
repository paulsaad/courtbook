#!/usr/bin/env bash
# Full 0.5.0 candidate (player photos included, Paul 27 Nov), staging app variant (LOCAL ONLY: scratch databases, never
# staging or live). Migrations: 0001–0093, 0099 (F1), 0100 (sports catalogue), 0101 (player photos). M12 (0094–0098)
# is not here.
#   PSQL="sudo -u postgres psql" PG_MODULE=/tmp/pgdeps/node_modules bash supabase/tests/candidate/run.sh
# 0  release set (exact migration list, no payment migration)
# A  F1 on the full schema: tests.sql, postcheck, race harness
# B  run.sh (all migrations, incl. 0100's run-once check) and the existing suites; the API journey/security scripts;
#    f1_rollout.mjs (rolls 0099 back, then the website-first rollout through real PostgREST)
# C  rollback 0101, 0100, then 0099 = a plain 0001–0093 build
# D  F1's own suite (run.sh with mutants) and activation package; the sports and photo suites and their rollbacks
# E  M12 later, out of order: 0001–0093, 0099, 0100, 0101, then 0094–0098 = the numeric order (needs M12_DIR)
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
export PG_MODULE=${PG_MODULE:-/tmp/pgdeps/node_modules} PSQL
M12_DIR=${M12_DIR:-}
fail=0; line() { printf '%-64s %s\n' "$1" "$2"; [[ "$2" == PASS* ]] || fail=1; }
build() {   # $1 db, $2 awk filter on file names, then extra files
  local db=$1 filt=$2; shift 2
  $PSQL -q -d postgres -c "drop database if exists $db" -c "create database $db" >/dev/null 2>&1 || return 2
  $PSQL -q -d $db -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql >/dev/null 2>&1 || return 2
  for f in $(ls supabase/migrations/*.sql | sort | awk -F/ "$filt") "$@"; do
    $PSQL -q -d $db -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null 2>&1 || { echo "cannot build $db: $f"; return 2; }
  done
  $PSQL -q -d $db -f supabase/seed.sql >/dev/null 2>&1 || true
}
fp() { { $PSQL -d $1 -X -At -f supabase/tests/schema_fingerprint.sql; $PSQL -d $1 -X -At -c "select 'fn '||p.oid::regprocedure||' '||md5(pg_get_functiondef(p.oid))||' '||coalesce(p.proacl::text,'') from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f'"; } 2>&1 | sort; }

echo "== 0. release set"
bash supabase/tests/candidate/release_set.sh | sed 's/^/  /'; [ ${PIPESTATUS[0]} = 0 ] && line "0 release set" PASS || line "0 release set" FAIL

echo "== A0. read-only preflights before, postchecks after (supabase/live)"
chk() { local out; out=$($PSQL -d $1 -X -At -F'|' -c "set default_transaction_read_only = on" -f "$2" 2>&1); [ -n "$(echo "$out" | grep '|')" ] && ! echo "$out" | grep -qE '\|STOP$|ERROR' && echo PASS || { echo FAIL; echo "$out" | grep -E 'STOP|ERROR' >&2; }; }
build courtbook_cand_pre99 '$NF < "0099"' && line "A0a F1 preflight on 0001–0093" "$(chk courtbook_cand_pre99 supabase/live/staff_moves_preflight.sql)" || line "A0a (build failed)" FAIL
build courtbook_cand_pre100 '$NF < "0100"' && line "A0b 0100 preflight on 0001–0093 + 0099" "$(chk courtbook_cand_pre100 supabase/live/sports_0100_preflight.sql)" || line "A0b (build failed)" FAIL
build courtbook_cand_full '1' && line "A0c 0100 postcheck on the full schema" "$(chk courtbook_cand_full supabase/live/sports_0100_postcheck.sql)" || line "A0c (build failed)" FAIL
o=$(bash supabase/tests/sports/preflight_0100.sh 2>&1); rc=$?; [ $rc = 0 ] && echo "$o" | grep -q "RESULT: PASS" && line "A0f 0100 preflight STOPs on each kind of bad data ($(echo "$o" | grep -c '^ok') cases)" PASS || { line "A0f 0100 preflight bad-data cases (rc=$rc)" FAIL; echo "$o" | grep FAIL; }
line "A0d F1 postcheck refuses before 0099 (control)" "$(chk courtbook_cand_pre99 supabase/live/staff_moves_postcheck.sql 2>/dev/null | grep -q FAIL && echo PASS || echo FAIL)"
line "A0e 0100 postcheck refuses before 0100 (control)" "$(chk courtbook_cand_pre100 supabase/live/sports_0100_postcheck.sql 2>/dev/null | grep -q FAIL && echo PASS || echo FAIL)"
$PSQL -q -d postgres -c "drop database if exists courtbook_cand_pre99" -c "drop database if exists courtbook_cand_pre100" -c "drop database if exists courtbook_cand_full" >/dev/null 2>&1

echo "== A. F1 on the full schema"
T=courtbook_cand_f1
if build $T '1' && (cd supabase/tests/staff_moves && $PSQL -d $T -X -q -At -v ON_ERROR_STOP=1 -f fixtures.sql >/dev/null 2>&1); then
  out=$( (cd supabase/tests/staff_moves && $PSQL -d $T -X -q -At -f tests.sql 2>&1) | grep -v '^$')
  echo "$out" | grep -q "checks: 15, failures: 0" && ! echo "$out" | grep -qE "^(FAIL|psql)|ERROR" && line "A1 F1 tests.sql" PASS || { line "A1 F1 tests.sql" FAIL; echo "$out" | tail -5; }
  post=$($PSQL -d $T -X -q -At -F'|' -v ON_ERROR_STOP=1 -f supabase/live/staff_moves_postcheck.sql 2>&1); prc=$?
  { [ $prc != 0 ] || [ -z "$(echo "$post" | grep '|')" ] || echo "$post" | grep -qE "\|STOP$|ERROR"; } && { line "A2 F1 postcheck" FAIL; echo "$post"; } || line "A2 F1 postcheck" PASS
  out=$(sudo -u postgres env PG_MODULE="$PG_MODULE" DB="postgresql:///$T?host=/var/run/postgresql" MODE=draft ROUNDS=20 node supabase/tests/staff_moves/race.mjs 2>&1)
  echo "$out" | grep -qE "^race checks: [0-9]+, failures: 0$" && ! echo "$out" | grep -q "^FAIL" \
    && line "A3 F1 races ($(echo "$out" | grep -E '^race checks' | sed 's/race checks: //'))" PASS || { line "A3 F1 races" FAIL; echo "$out" | grep -E "^FAIL|race checks" | head; }
else line "A0 full build" FAIL; fi
$PSQL -q -d postgres -c "drop database if exists $T" >/dev/null 2>&1

echo "== B. existing suites on the full schema"
bash supabase/tests/run.sh > /tmp/cand050s_run.log 2>&1; rrc=$?
[ $rrc = 0 ] && grep -q "SUITE OK" /tmp/cand050s_run.log && line "B0 run.sh ($(grep -E 'checks:' /tmp/cand050s_run.log | tail -1); $(grep -cE "ok +106[efg]" /tmp/cand050s_run.log)/3 convergence checks)" PASS || { line "B0 run.sh" FAIL; grep -E "FAIL" /tmp/cand050s_run.log | head; }
for s in races/booking_races.sh races/court_deactivation_race.sh races/closed_account_booking.sh staff_ops/staff_ops.sh \
         m83/cancel.sh m3/safety.sh m3/hardening.sh m3/hardening_races.sh m10/moderation.sh m80/age.sh \
         m86/deletion86.sh m86/races86.sh m86/pipeline_e2e.sh m86/old_app_answers.sh m86/ported_deletion_races.sh \
         integration/m2_m14.sh repeat_use/repeat_use.sh favourites/club_favourites.sh club_setup/club_setup.sh; do
  timeout 900 bash supabase/tests/$s > /tmp/cand050s_$(echo $s | tr / _).log 2>&1; rc=$?
  sum=$(grep -Ei "^RESULT|summary|checks, [0-9]+ failed|ALL: " /tmp/cand050s_$(echo $s | tr / _).log | tail -1)
  [ $rc = 0 ] && ! echo "$sum" | grep -qE "(^| )FAIL|[1-9][0-9]* failed|[1-9][0-9]* FAIL" && line "B $s" "PASS  $sum" || line "B $s" "FAIL rc=$rc $sum"
done
mkdir -p /tmp/courtbook-api
for S in journey.mjs security.mjs; do
  SCRIPT=$S bash supabase/tests/api/journey.sh > /tmp/cand050s_api_$S.log 2>&1 && line "B api $S" "PASS  $(grep summary /tmp/cand050s_api_$S.log | tail -1)" || { line "B api $S" FAIL; grep -E "^FAIL" /tmp/cand050s_api_$S.log | head -5; }
done
# last: it rolls 0099 back on its scratch copy
SCRIPT=f1_rollout.mjs bash supabase/tests/api/journey.sh > /tmp/cand050s_f1r.log 2>&1 && line "B api f1_rollout.mjs ($(grep -c '^ok' /tmp/cand050s_f1r.log) ok)" PASS || { line "B api f1_rollout.mjs" FAIL; grep -E "^FAIL" /tmp/cand050s_f1r.log | head -5; }

echo "== C. rollback 0101, 0100, then 0099 = plain 0001–0093"
P=courtbook_cand_plain; R=courtbook_cand_rb
build $P '$NF < "0094"' && build $R '1'
r=$($PSQL -q -d $R -v ON_ERROR_STOP=1 -1 -f supabase/rollback/0101_down.sql 2>&1 | grep ERROR)$($PSQL -q -d $R -v ON_ERROR_STOP=1 -1 -f supabase/rollback/0100_down.sql 2>&1 | grep ERROR)$($PSQL -q -d $R -v ON_ERROR_STOP=1 -1 -f supabase/rollback/0099_down.sql 2>&1 | grep ERROR)
d=$(diff <(fp $P) <(fp $R))
[ -z "$r" ] && [ -z "$d" ] && line "C1 rolled back = plain 0001–0093 ($(fp $P | wc -l) items incl. function bodies)" PASS || { line "C1 rollback" FAIL; echo "$r"; echo "$d" | head; }
$PSQL -q -d postgres -c "drop database if exists $P" -c "drop database if exists $R" >/dev/null 2>&1

echo "== D. own suites"
o=$(bash supabase/tests/staff_moves/run.sh 2>&1); rc=$?; [ $rc = 0 ] && echo "$o" | tail -1 | grep -q "PASS" && line "D staff_moves/run.sh ($(echo "$o" | grep 'mutants caught' | tail -1))" PASS || { line "D staff_moves/run.sh" FAIL; echo "$o" | tail -8; }
o=$(bash supabase/tests/staff_moves/activation.sh 2>&1); rc=$?; { [ $rc != 0 ] || echo "$o" | grep -qE "^  FAIL" || [ "$(echo "$o" | grep -c '^  ok')" = 0 ]; } && { line "D staff_moves/activation.sh (rc=$rc)" FAIL; echo "$o" | grep -E "FAIL|REFUSED" | head; } || line "D staff_moves/activation.sh ($(echo "$o" | grep -c '^  ok') ok)" PASS
o=$(bash supabase/tests/staff_moves/compat.sh 2>&1); rc=$?; [ $rc = 0 ] && echo "$o" | grep -q "existing suites with the F1 draft: PASS" && line "D staff_moves/compat.sh (legacy adapter as 0099z)" PASS || { line "D staff_moves/compat.sh (rc=$rc)" FAIL; echo "$o" | grep -E "FAIL" | head; }
bash supabase/tests/run.sh >/dev/null 2>&1   # compat.sh leaves its test-only adapter in courtbook_test: rebuild it
o=$(bash supabase/tests/sports/sports_catalogue.sh 2>&1); rc=$?; n=$(echo "$o" | grep -c "^ok"); { [ $rc != 0 ] || [ $n = 0 ] || echo "$o" | grep -q "^FAIL\|BUILD"; } && { line "D sports_catalogue.sh" FAIL; echo "$o" | grep "^FAIL\|BUILD" | head; } || line "D sports_catalogue.sh ($n ok)" PASS
o=$(bash supabase/tests/sports/sports_catalogue_rollback.sh 2>&1); rc=$?; n=$(echo "$o" | grep -c "^ok"); { [ $rc != 0 ] || [ $n = 0 ] || echo "$o" | grep -q "^FAIL\|BUILD"; } && { line "D sports rollback" FAIL; echo "$o" | grep "^FAIL\|BUILD" | head; } || line "D sports rollback ($n ok)" PASS
o=$(bash supabase/tests/photo/player_photos.sh 2>&1); rc=$?; n=$(echo "$o" | grep -c "^ok"); { [ $rc != 0 ] || [ $n = 0 ] || echo "$o" | grep -q "^FAIL\|BUILD"; } && { line "D photo player_photos.sh" FAIL; echo "$o" | grep "^FAIL\|BUILD" | head; } || line "D photo player_photos.sh ($n ok)" PASS
o=$(CONTROL=1 bash supabase/tests/photo/player_photos.sh 2>&1); n=$(echo "$o" | grep -c "^FAIL")
[ "$n" -ge 15 ] && echo "$o" | grep -q "^FAIL V2" && echo "$o" | grep -q "^FAIL P4" && line "D photo control (rule weakened: $n privacy cases fail, as they must)" PASS || line "D photo control (only $n failed)" FAIL
o=$(bash supabase/tests/photo/player_photos_rollback.sh 2>&1); rc=$?; n=$(echo "$o" | grep -c "^ok"); { [ $rc != 0 ] || [ $n = 0 ] || echo "$o" | grep -q "^FAIL\|BUILD"; } && { line "D photo rollback" FAIL; echo "$o" | grep -A3 "^FAIL\|BUILD" | head; } || line "D photo rollback ($n ok)" PASS

echo "== E. M12 later, out of order"
if [ -n "$M12_DIR" ] && ls "$M12_DIR"/009[4-8]_*.sql >/dev/null 2>&1; then
  M=$(ls "$M12_DIR"/009[4-8]_*.sql | sort | tr '\n' ' ')
  N=courtbook_cand_num; O=courtbook_cand_ooo
  build $N '$NF < "0094"' $M supabase/migrations/0099_*.sql supabase/migrations/0100_*.sql supabase/migrations/0101_*.sql && build $O '1' $M
  d=$(diff <(fp $N) <(fp $O))
  [ -z "$d" ] && line "E1 0099–0101, then M12 = M12, then 0099–0101 ($(fp $N | wc -l) items)" PASS || { line "E1 order" FAIL; echo "$d" | head; }
  $PSQL -q -d postgres -c "drop database if exists $N" -c "drop database if exists $O" >/dev/null 2>&1
else echo "E1 skipped (M12_DIR not given)"; fi

[ $fail = 0 ] && echo "CANDIDATE 0.5.0 (full, with photos, staging variant): PASS" || echo "CANDIDATE 0.5.0 (full, with photos, staging variant): FAIL"
exit $fail
