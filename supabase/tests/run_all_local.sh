#!/usr/bin/env bash
# The whole local test matrix, each suite exactly ONCE with its intended arguments. LOCAL ONLY (local PostgreSQL via
# sudo -u postgres, scratch databases; never staging or live). Exit 0 and "ALL GREEN" only when every suite passed.
#   bash supabase/tests/run_all_local.sh [out_dir]
#
# Why explicit rather than "every *.sh": two suites need arguments to test this tree —
#   - audit/run_audit.sh defaults to the live-equivalent schema (origin/mobile-m2-native, 0001–0066); its checks follow
#     this tree, so it is run with HEAD (the default run is a different question: what live has, for docs/audit);
#   - m86/pipeline_e2e.sh needs the "pg" package (PG_MODULE), installed here once if missing.
# Helpers (build_db.sh, start/stop, staging_* and rehearsal scripts that need staging) are not suites.
set -u
cd "$(dirname "$0")/../.."
OUT=${1:-/tmp/courtbook-matrix}; rm -rf "$OUT"; mkdir -p "$OUT"; : > "$OUT/summary.txt"
export PSQL="sudo -u postgres psql"
export PG_MODULE=${PG_MODULE:-/tmp/pgdeps/node_modules}
sudo service postgresql start >/dev/null 2>&1
if [ ! -d "$PG_MODULE/pg" ]; then
  mkdir -p "$(dirname "$PG_MODULE")" && (cd "$(dirname "$PG_MODULE")" && npm init -y >/dev/null && npm install --no-audit --no-fund pg@8 >/dev/null) \
    || { echo "could not install pg into $PG_MODULE"; exit 2; }
fi
# Autovacuum off while the matrix runs, put back on exit. Suites build hundreds of scratch databases with DDL; on
# 25 Nov an autovacuum ANALYZE of a freshly built table deadlocked once with the next migration's DROP POLICY and the
# migration lost (m85 rehearsal "cannot build: 0032"). A real failure, but of this machine's housekeeping, not of the
# code under test. LOCAL cluster only.
av=$(sudo -u postgres psql -At -c "show autovacuum")
sudo -u postgres psql -q -c "alter system set autovacuum = off" -c "select pg_reload_conf()" >/dev/null
trap 'sudo -u postgres psql -q -c "alter system set autovacuum = $av" -c "select pg_reload_conf()" >/dev/null 2>&1' EXIT
fails=0; total=0
run() { local name=$1; shift; local t0; t0=$(date +%s); total=$((total+1))
  sudo service postgresql status >/dev/null 2>&1 || sudo service postgresql start >/dev/null 2>&1
  timeout "${TMO:-1500}" "$@" > "$OUT/$name.log" 2>&1; local rc=$?
  [ $rc = 0 ] || fails=$((fails+1))
  printf "%-36s %-4s %4ss  %s\n" "$name" "$([ $rc = 0 ] && echo ok || echo FAIL)" "$(( $(date +%s) - t0 ))" \
    "$(grep -v '^\s*$' "$OUT/$name.log" | tail -1 | cut -c1-100)" | tee -a "$OUT/summary.txt"; }
skip='^supabase/tests/(run\.sh|run_all_local\.sh|audit/(build_db|run_audit)\.sh|m86/pipeline_e2e\.sh|api/.*|launch1/rehearsal.*|.*staging_.*|.*live_blocks.*)$'

run run.sh bash supabase/tests/run.sh                                       # builds courtbook_test, the base of the others
for f in $(find supabase/tests -name "*.sh" | sort | grep -vE "$skip"); do
  run "$(echo "${f#supabase/tests/}" | sed 's|/|__|g')" bash "$f"
done
[ -f supabase/tests/races/booking_races.sh ] && run races__booking_races_fee env FEE=1 bash supabase/tests/races/booking_races.sh
run m86__pipeline_e2e bash supabase/tests/m86/pipeline_e2e.sh
run audit__run_audit_HEAD bash supabase/tests/audit/run_audit.sh HEAD
for s in journey security native gateway gateway2 ledger; do
  [ -f "supabase/tests/api/$s.mjs" ] && run "api__$s" env SCRIPT=$s.mjs bash supabase/tests/api/journey.sh
done
for t in .github/tests/*.sh; do [ -f "$t" ] && run "workflow__$(basename "$t" .sh)" sudo -u postgres bash "$t"; done
run web__tsc npx tsc --noEmit
run web__vitest npx vitest run
run app__tsc bash -c "cd mobile && npx tsc --noEmit -p ."
run app__jest bash -c "cd mobile && npx jest --silent --forceExit"     # --forceExit: a known open handle keeps jest alive after the run
echo "$((total-fails)) of $total suites passed" | tee -a "$OUT/summary.txt"
[ $fails = 0 ] && echo "ALL GREEN" | tee -a "$OUT/summary.txt"
[ $fails = 0 ]
