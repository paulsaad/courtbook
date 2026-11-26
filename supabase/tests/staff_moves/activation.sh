#!/usr/bin/env bash
# F1 activation package (review S1): every suite and staging check that moves a booking, converted to F1's
# 8-argument call (made with the booking's CURRENT position, i.e. a desk with a fresh view), run against
# 0001–0093 + F1's draft as a temporary 0094. NO test adapter. LOCAL ONLY; rebuilds courtbook_test (re-run
# supabase/tests/run.sh afterwards for the branch's own database).
#   PSQL="sudo -u postgres psql" PG_MODULE=/tmp/pgdeps/node_modules bash supabase/tests/staff_moves/activation.sh
# Also shows WHY these changes must ship together with the numbered migration: on 0001–0093 alone the converted
# suites fail (the 8-argument call does not exist yet).
set -u
cd "$(dirname "$0")/../../.."
export PSQL=${PSQL:-psql} PG_MODULE=${PG_MODULE:-/tmp/pgdeps/node_modules}
last=$(ls supabase/migrations | sort | tail -1)
[ "$last" = "0093_closed_account_booking_lock_order.sql" ] || { echo "unexpected last migration: $last (give F1 its number and update this script)"; exit 2; }
W="$(cd .. && pwd)/.f1activation-$$"
git worktree add -q --detach "$W" HEAD || exit 2
trap 'git worktree remove --force "$W" >/dev/null 2>&1' EXIT
[ -d node_modules ] && ln -s "$(pwd)/node_modules" "$W/node_modules"
cp docs/staff-moves/sql/move_checks_what_desk_saw.draft.sql "$W/supabase/migrations/0094_f1_draft_TEMPORARY.sql"
cd "$W"
status=PASS
line() { echo "$1" | grep -E "checks: [0-9]+, failures|RESULT|SUITE|race checks|summary|passed|failed|PASS|FAIL" | tail -2 | tr '\n' ' '; }
step() { local name=$1; shift; out=$("$@" 2>&1); r=$?
  if [ $r -eq 0 ]; then echo "  ok    $name  ($(line "$out"))"; else echo "  FAIL  $name  ($(line "$out"))"; echo "$out" | grep -E "^ *(FAIL|not ok)" | head -10; status=FAIL; fi; }
must_fail() { local name=$1; shift; out=$("$@" 2>&1); r=$?
  if [ $r -ne 0 ]; then echo "  ok    $name fails, as it must  ($(line "$out"))"; else echo "  FAIL  $name passed, but it should have shown the defect"; status=FAIL; fi; }

echo "== converted suites on 0001–0093 + F1 (no adapter)"
step "run.sh (builds courtbook_test 0001–0094 temporary)" bash supabase/tests/run.sh
step "staff_ops" bash supabase/tests/staff_ops/staff_ops.sh
must_fail "staff_ops CONTROL (pre-0091 mover behind the desk's call)" env CONTROL=1 bash supabase/tests/staff_ops/staff_ops.sh
step "fixes/run_fixes" bash supabase/tests/fixes/run_fixes.sh
step "fixes/d3_time" bash supabase/tests/fixes/d3_time.sh
step "races/booking_races" bash supabase/tests/races/booking_races.sh
step "races/court_deactivation_race" bash supabase/tests/races/court_deactivation_race.sh
step "m86/ported_deletion_races" bash supabase/tests/m86/ported_deletion_races.sh
step "m2/deletion_races" bash supabase/tests/m2/deletion_races.sh
step "api/journey (real PostgREST)" bash supabase/tests/api/journey.sh
# the staging checks, run here against a scratch copy of courtbook_test (they refuse the live project)
$PSQL -q -d postgres -c "drop database if exists courtbook_f1stage" -c "create database courtbook_f1stage template courtbook_test" >/dev/null 2>&1
# staging's auth.users has columns the local shim lacks (aud, role): added to this copy only
$PSQL -q -d courtbook_f1stage -c "alter table auth.users add column if not exists aud text, add column if not exists role text" >/dev/null 2>&1
smoke() {   # passes if the only failure is S4 (it runs only between 11:00 and 21:30 Beirut: said, not hidden)
  local out; out=$(sudo -u postgres env DB="postgresql:///courtbook_f1stage?host=/var/run/postgresql" bash supabase/tests/staging_smoke.sh 2>&1)
  echo "$out" | grep -E "^  FAIL" | grep -v "S4 not run" && return 1
  echo "$out" | grep -q "S4 not run" && echo "  (S4 not run here: outside 11:00–21:30 Beirut; its rules are covered by fixes/d3_time)"
  echo "$out" | tail -1
}
step "staging_smoke.sh (staging check, on a local copy)" smoke
rc_post() {   # strict (review R106-1): psql must succeed, every row ok, all rows present, and the 0091 row must say F1
  local out n
  out=$(sudo -u postgres psql -d courtbook_f1stage -X -At -v ON_ERROR_STOP=1 -f supabase/live/rc_0086_0091_postcheck.sql 2>&1) || { echo "$out"; echo "FAIL psql stopped"; return 1; }
  echo "$out"
  n=$(echo "$out" | grep -c '|')
  [ "$n" -ge "$RC_ROWS" ] || { echo "FAIL only $n rows (expected $RC_ROWS)"; return 1; }
  echo "$out" | awk -F'|' 'NF < 3 || $2 != "t" {bad=1} END {exit bad}' || { echo "FAIL a row is not ok"; return 1; }
  echo "$out" | grep -q "^0091: .*|t|F1$" || { echo "FAIL the 0091 row does not report F1"; return 1; }
  echo "rc postcheck PASS: $n rows ok, 0091 row reports F1"
}
RC_ROWS=$(( $(grep -c "union all select" supabase/live/rc_0086_0091_postcheck.sql) + 1 ))
step "rc_0086_0091_postcheck (staging check, read only, on a local copy)" rc_post
$PSQL -q -d postgres -c "drop database if exists courtbook_f1stage" >/dev/null

echo "== the same suites on 0001–0093 WITHOUT F1: they must fail (so they ship with the migration, never before)"
rm "supabase/migrations/0094_f1_draft_TEMPORARY.sql"
bash supabase/tests/run.sh >/dev/null 2>&1   # courtbook_test 0001–0093
must_fail "staff_ops without F1" bash supabase/tests/staff_ops/staff_ops.sh
echo "existing suites converted for F1: $status"
[ "$status" = PASS ]
