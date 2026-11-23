#!/usr/bin/env bash
# Runs pipeline_e2e.mjs: the website pipeline (TypeScript) against 0086 on a disposable copy of courtbook_test.
# Needs Node 22.6+ (type stripping) and the "pg" package somewhere outside the repo:
#   mkdir -p /tmp/pgdeps && (cd /tmp/pgdeps && npm init -y && npm install pg@8)
#   PG_MODULE=/tmp/pgdeps/node_modules bash supabase/tests/m86/pipeline_e2e.sh
set -u
cd "$(dirname "$0")/../../.."
SRC=courtbook_test; DB=courtbook_m86_e2e
: "${PG_MODULE:?set PG_MODULE to a node_modules folder containing pg}"
sudo -u postgres psql -q -d postgres -c "drop database if exists $DB" -c "create database $DB template $SRC" >/dev/null || exit 2
run() { sudo -u postgres psql -q -d postgres -c "drop database if exists $DB" -c "create database $DB template $SRC" >/dev/null || exit 2
        sudo -u postgres env PG_MODULE="$PG_MODULE" E2E_DB=$DB ${1:+E2E_PIPELINE=$1} node --experimental-strip-types --no-warnings supabase/tests/m86/pipeline_e2e.mjs; }
run; rc=$?

# mutants of the pipeline: each must make at least one check fail
M=$(mktemp -d); chmod 755 "$M"; trap 'rm -rf "$M"' EXIT
mutant() {   # $1 name, $2 python expression transforming s, $3 "survives" = expected to survive (reason in the comment)
  python3 -c "import sys; s=open('src/lib/deletion/pipeline.ts').read(); t=$2; assert t != s, 'mutant did not apply'; open('$M/$1.ts','w').write(t)" || { echo "FAIL  mutant $1 did not apply"; rc=1; return; }
  chmod 644 "$M/$1.ts"
  if run "$M/$1.ts" >"$M/$1.out" 2>&1; then
    if [ "${3:-}" = survives ]; then echo "ok    mutant $1 survives as expected (harmless; see comment)"; else echo "FAIL  mutant $1 survived"; rc=1; fi
  else
    if [ "${3:-}" = survives ]; then echo "FAIL  mutant $1 was expected to be harmless but broke $(grep -c '^FAIL' "$M/$1.out") checks"; rc=1;
    else echo "ok    mutant $1 detected ($(grep -c '^FAIL' "$M/$1.out") failing checks)"; fi
  fi
}
echo; echo "== pipeline mutants"
mutant skip_rerun_of_C 's.replace("const data = await deps.rpc(\"delete_account_data\", { p_subject: subject, p_cancel_only: false });", "const data = claim.status === \"data_removed\" ? { data: null, error: null } : await deps.rpc(\"delete_account_data\", { p_subject: subject, p_cancel_only: false });")'
mutant no_ban 's.replace("const b = await deps.banUser(subject);", "const b = { error: null };")'
mutant held_runs_full_data 's.replace("p_cancel_only: true", "p_cancel_only: false")'
# Expected survivors, kept so a change in their behaviour is noticed:
#  - a run that ignores losing its lease only repeats idempotent steps: same end state (the stop is unit-tested in
#    src/lib/deletion/pipeline.test.ts, "a run whose lease was taken over stops")
#  - deleting the sign-in before the data step is refused by profiles_delete_guard; the mutant ignores the refusal and
#    the run then completes normally. Surviving here IS the guard working (also 0086 suite G8)
#  - no lease renewal at all (review 23 Nov, finding 5): a worker that was taken over carries on beside the new one. E9
#    must still end in the same state, because every step is idempotent: renewal only makes it stop sooner
#    (the renewal is replaced by a harmless read, so the run makes the same number of calls and E9 pauses at the same points)
mutant no_renewal 's.replace("const r = await record(\"renew\");", "const r = (await deps.rpc(\"deletion_processing_active\", {}), true) as boolean | \"error\";")' survives
mutant ignore_lease_lost 's.replace("if (r === false) return { result: \"lease_lost\", step: \"ban\" };", "")' survives
mutant delete_before_data 's.replace("    // C: always (see header)", "    await deps.deleteUser(subject);\n    // C: always (see header)")' survives
mutant no_finish 's.replace("const fin = await deps.rpc(\"finish_account_deletion\", { p_subject: subject });", "const fin = { error: null };")'

sudo -u postgres psql -q -d postgres -c "drop database if exists $DB" >/dev/null
echo; [ $rc = 0 ] && echo "ALL: PASS" || echo "ALL: FAIL"
exit $rc
