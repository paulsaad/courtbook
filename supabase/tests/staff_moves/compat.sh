#!/usr/bin/env bash
# The existing database suites with the F1 draft applied (as a temporary 0094) plus the TEST-ONLY legacy adapter (0095),
# in a temporary git worktree of this commit. Shows the draft changes nothing but the comparison. LOCAL ONLY; rebuilds
# courtbook_test (re-run supabase/tests/run.sh afterwards to get the branch's own database back).
#   PSQL="sudo -u postgres psql" PG_MODULE=/tmp/pgdeps/node_modules bash supabase/tests/staff_moves/compat.sh
set -u
cd "$(dirname "$0")/../../.."
export PSQL=${PSQL:-psql} PG_MODULE=${PG_MODULE:-/tmp/pgdeps/node_modules}
# a temporary git worktree of this commit (some suites build from git refs or need the checkout's own paths)
W="$(cd .. && pwd)/.f1compat-$$"
git worktree add -q --detach "$W" HEAD || exit 2
trap 'git worktree remove --force "$W" >/dev/null 2>&1' EXIT
[ -d node_modules ] && ln -s "$(pwd)/node_modules" "$W/node_modules"
last=$(ls supabase/migrations | sort | tail -1); [ "$last" = "0093_closed_account_booking_lock_order.sql" ] || { echo "unexpected last migration: $last"; exit 2; }
cp docs/staff-moves/sql/move_checks_what_desk_saw.draft.sql "$W/supabase/migrations/0094_f1_draft_TEMPORARY.sql"
cp supabase/tests/staff_moves/legacy_adapter.sql "$W/supabase/migrations/0095_f1_legacy_adapter_TEST_ONLY.sql"
cd "$W"
status=PASS
step() { local name=$1; shift; out=$("$@" 2>&1); r=$?; line=$(echo "$out" | grep -E "checks: [0-9]+, failures|RESULT|SUITE|race checks|passed|failed|PASS|FAIL" | tail -2 | tr '\n' ' ');
  if [ $r -eq 0 ]; then echo "  ok    $name  ($line)"; else echo "  FAIL  $name  ($line)"; echo "$out" | grep -E "^ *(FAIL|not ok)" | head -10; status=FAIL; fi; }
step "run.sh (builds courtbook_test 0001-0095)" bash supabase/tests/run.sh
step "staff_ops" bash supabase/tests/staff_ops/staff_ops.sh
step "fixes/run_fixes" bash supabase/tests/fixes/run_fixes.sh
step "fixes/d3_time" bash supabase/tests/fixes/d3_time.sh
step "races/booking_races" bash supabase/tests/races/booking_races.sh
step "races/court_deactivation_race" bash supabase/tests/races/court_deactivation_race.sh
step "m86/ported_deletion_races" bash supabase/tests/m86/ported_deletion_races.sh
echo "existing suites with the F1 draft: $status"
[ "$status" = PASS ]
