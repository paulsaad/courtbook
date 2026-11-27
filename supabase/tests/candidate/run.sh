#!/usr/bin/env bash
# 0.5.0 INTEGRATION CANDIDATE (disposable branch, never an official one). LOCAL ONLY: scratch databases, never staging
# or live. The three unnumbered drafts are applied after 0001–0093 in the proposed order, F1 → sports → photo, exactly
# as numbered migrations would be (each in one transaction). M12 (0094–0098) is NOT part of this candidate.
#   PSQL="sudo -u postgres psql" PG_MODULE=/tmp/pgdeps/node_modules bash supabase/tests/candidate/run.sh
# A  combined schema: F1's own tests (tests.sql 15/15) and race harness (moves vs moves, move vs cancel), postcheck
# B  run.sh (381 checks) with all three drafts, then the existing suites on that database: double bookings and races,
#    staff operations, cancellation, closure/deletion pipeline, moderation, safety, old app answers, the API journey and
#    security scripts (the website's and app's own supabase-js calls through PostgREST)
# C  rollback in reverse order (photo → sports → F1) returns exactly a plain 0001–0093 build
# D  each draft's own suite on the candidate tree (sports 48, photo 77 + rollback 16, F1 run.sh)
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
export PG_MODULE=${PG_MODULE:-/tmp/pgdeps/node_modules} PSQL
F1=docs/staff-moves/sql/move_checks_what_desk_saw.draft.sql;  F1D=docs/staff-moves/sql/move_checks_what_desk_saw.down.draft.sql
SP=docs/sports/sql/sports_catalogue.draft.sql;                SPD=docs/sports/sql/sports_catalogue.down.draft.sql
PH=docs/profile-photo/sql/player_photos.draft.sql;            PHD=docs/profile-photo/sql/player_photos.down.draft.sql
fail=0; line() { printf '%-60s %s\n' "$1" "$2"; [[ "$2" == PASS* ]] || fail=1; }
build() {   # $1 db, then draft files
  local db=$1; shift
  $PSQL -q -d postgres -c "drop database if exists $db" -c "create database $db" >/dev/null || return 2
  $PSQL -q -d $db -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql >/dev/null 2>&1 || return 2
  for f in $(ls supabase/migrations/*.sql | sort) "$@"; do
    $PSQL -q -d $db -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null 2>&1 || { echo "cannot build $db: $f"; return 2; }
  done
  $PSQL -q -d $db -f supabase/seed.sql >/dev/null 2>&1 || true
}

echo "== A. F1 on the combined schema"
T=courtbook_cand_f1
if build $T $F1 $SP $PH && (cd supabase/tests/staff_moves && $PSQL -d $T -X -q -At -v ON_ERROR_STOP=1 -f fixtures.sql >/dev/null 2>&1); then
  out=$( (cd supabase/tests/staff_moves && $PSQL -d $T -X -q -At -f tests.sql 2>&1) | grep -v '^$')
  echo "$out" | grep -q "checks: 15, failures: 0" && ! echo "$out" | grep -qE "^(FAIL|psql)|ERROR" && line "A1 F1 tests.sql" PASS || { line "A1 F1 tests.sql" FAIL; echo "$out" | tail -5; }
  post=$($PSQL -d $T -X -q -At -F'|' -f supabase/live/staff_moves_postcheck.sql 2>&1)
  echo "$post" | grep -q "|STOP$" && { line "A2 F1 postcheck" FAIL; echo "$post"; } || line "A2 F1 postcheck" PASS
  out=$(sudo -u postgres env PG_MODULE="$PG_MODULE" DB="postgresql:///$T?host=/var/run/postgresql" MODE=draft ROUNDS=20 node supabase/tests/staff_moves/race.mjs 2>&1)
  echo "$out" | grep -qE "^race checks: [0-9]+, failures: 0$" && ! echo "$out" | grep -q "^FAIL" \
    && line "A3 F1 races ($(echo "$out" | grep -E '^race checks' | sed 's/race checks: //'))" PASS || { line "A3 F1 races" FAIL; echo "$out" | grep -E "^FAIL|race checks" | head; }
else line "A0 combined build" FAIL; fi
$PSQL -q -d postgres -c "drop database if exists $T" >/dev/null

echo "== B. existing suites with all three drafts"
EXTRA_MIGRATIONS="$F1 $SP $PH" bash supabase/tests/run.sh > /tmp/cand_run.log 2>&1
grep -q "SUITE OK" /tmp/cand_run.log && line "B0 run.sh ($(grep -E 'checks:' /tmp/cand_run.log | tail -1))" PASS || { line "B0 run.sh" FAIL; grep -E "FAIL" /tmp/cand_run.log | head; }
for s in races/booking_races.sh races/court_deactivation_race.sh races/closed_account_booking.sh staff_ops/staff_ops.sh \
         m83/cancel.sh m3/safety.sh m3/hardening.sh m3/hardening_races.sh m10/moderation.sh m80/age.sh \
         m86/deletion86.sh m86/races86.sh m86/pipeline_e2e.sh m86/old_app_answers.sh m86/ported_deletion_races.sh \
         integration/m2_m14.sh repeat_use/repeat_use.sh favourites/club_favourites.sh club_setup/club_setup.sh; do
  timeout 900 bash supabase/tests/$s > /tmp/cand_$(echo $s | tr / _).log 2>&1; rc=$?
  sum=$(grep -Ei "^RESULT|summary|checks, [0-9]+ failed|ALL: " /tmp/cand_$(echo $s | tr / _).log | tail -1)
  [ $rc = 0 ] && ! echo "$sum" | grep -qE "(^| )FAIL|[1-9][0-9]* failed|[1-9][0-9]* FAIL" && line "B $s" "PASS  $sum" || { line "B $s" "FAIL rc=$rc $sum"; }
done
mkdir -p /tmp/courtbook-api
for S in journey.mjs security.mjs; do
  SCRIPT=$S bash supabase/tests/api/journey.sh > /tmp/cand_api_$S.log 2>&1 && line "B api $S" "PASS  $(grep summary /tmp/cand_api_$S.log | tail -1)" || { line "B api $S" FAIL; tail -5 /tmp/cand_api_$S.log; }
done

echo "== C. rollback in reverse order"
P=courtbook_cand_plain; R=courtbook_cand_rb
build $P && build $R $F1 $SP $PH
r=$({ echo "set local courtbook.discard_player_photos = 'yes';"; cat $PHD; } | $PSQL -q -d $R -v ON_ERROR_STOP=1 -1 2>&1 | grep ERROR)
r=$r$($PSQL -q -d $R -v ON_ERROR_STOP=1 -1 -f $SPD 2>&1 | grep ERROR)
r=$r$($PSQL -q -d $R -v ON_ERROR_STOP=1 -1 -f $F1D 2>&1 | grep ERROR)
fp() { $PSQL -d $1 -X -At -f supabase/tests/schema_fingerprint.sql 2>&1 | sort; }
d=$(diff <(fp $P) <(fp $R))
[ -z "$r" ] && [ -z "$d" ] && line "C1 photo, sports, F1 rolled back = plain 0001–0093 ($(fp $P | wc -l) items)" PASS || { line "C1 rollback" FAIL; echo "$r"; echo "$d" | head; }
$PSQL -q -d postgres -c "drop database if exists $P" -c "drop database if exists $R" >/dev/null

echo "== D. each draft's own suite on this tree"
o=$(bash supabase/tests/sports/sports_catalogue.sh 2>&1); n=$(echo "$o" | grep -c "^ok"); echo "$o" | grep -q "^FAIL" && line "D sports_catalogue.sh" FAIL || line "D sports_catalogue.sh ($n ok)" PASS
o=$(bash supabase/tests/sports/sports_catalogue_rollback.sh 2>&1); n=$(echo "$o" | grep -c "^ok"); echo "$o" | grep -q "^FAIL" && line "D sports rollback" FAIL || line "D sports rollback ($n ok)" PASS
o=$(bash supabase/tests/photo/player_photos.sh 2>&1); n=$(echo "$o" | grep -c "^ok"); echo "$o" | grep -q "^FAIL" && line "D player_photos.sh" FAIL || line "D player_photos.sh ($n ok)" PASS
o=$(bash supabase/tests/photo/player_photos_rollback.sh 2>&1); n=$(echo "$o" | grep -c "^ok"); echo "$o" | grep -q "^FAIL" && line "D photo rollback" FAIL || line "D photo rollback ($n ok)" PASS
o=$(bash supabase/tests/staff_moves/run.sh 2>&1); echo "$o" | tail -1 | grep -q "PASS" && line "D staff_moves/run.sh ($(echo "$o" | tail -1))" PASS || { line "D staff_moves/run.sh" FAIL; echo "$o" | tail -8; }
[ $fail = 0 ] && echo "CANDIDATE: PASS" || echo "CANDIDATE: FAIL"
exit $fail
