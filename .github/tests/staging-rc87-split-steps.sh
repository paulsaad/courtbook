#!/usr/bin/env bash
# Rehearses the planned split for 0087–0092 (docs/ops/staging-0087-0092-sequence.md: B = 0087 0088 0089, C = 0090,
# D = 0091, E = 0092) LOCALLY, running the workflow's own step scripts against a scratch 0001–0086 database.
# Never touches staging.
#   sudo -u postgres bash .github/tests/staging-rc87-split-steps.sh
set -u
cd "$(dirname "$0")/../.."
S=courtbook_wfsplit; FAILS=0
export DB="postgresql:///$S" REF=localrehearsal GITHUB_SHA=0000000rehearsal
ok() { if [ "$2" = 0 ]; then echo "ok    $1"; else echo "FAIL  $1"; FAILS=$((FAILS+1)); fi; }
trap 'psql -q -d postgres -c "drop database if exists $S" >/dev/null 2>&1' EXIT
step() { python3 -c "import sys,yaml; w=yaml.safe_load(open('.github/workflows/staging-db.yml')); r=[s['run'] for j in w['jobs'].values() for s in j['steps'] if s.get('name')==sys.argv[1]]; assert len(r)==1, sys.argv[1]; print(r[0])" "$1"; }
# GitHub runs each step with "bash -e {0}" (the workflow sets no shell:), so the rehearsal does too
run_step() { local name=$1; shift; env "$@" bash -e -c "$(step "$name")" 2>&1; }
applied() { psql -At -d $S -c "select count(*) from staging_meta.applied where name ~ '^00(8[7-9]|9[0-2])_'"; }
psql -q -d postgres -c "drop database if exists $S" -c "create database $S" >/dev/null
psql -q -d $S -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql >/dev/null || exit 2
psql -q -d $S -c "create schema staging_meta; create table staging_meta.applied (name text primary key, applied_at timestamptz not null default now(), sha text)" >/dev/null
for f in $(ls supabase/migrations/*.sql | sort); do
  n=$(basename "$f"); [ "${n:0:4}" \< 0087 ] || continue
  { cat "$f"; echo; echo "insert into staging_meta.applied (name) values ('$n');"; } | psql -q -d $S -v ON_ERROR_STOP=1 -1 >/dev/null 2>&1 || { echo "setup failed: $n"; exit 2; }
done
APPLY="Apply exactly the migrations named"
out=$(run_step "Release candidate 0087–0092 preflight after 0086, read only (rc87_preflight)"); ok "A: rc87_preflight passes on 0001–0086" $?
out=$(run_step "$APPLY" MIGRATIONS="0087 0088 0089"); rc=$?
[ $rc = 0 ] && echo "$out" | grep -q "0087–0092: running the preflight" && [ "$(applied)" = 3 ] && ! echo "$out" | grep -q "all seven applied"
ok "B: 0087 0088 0089 — preflight first, three applied, no postcheck yet" $?
out=$(run_step "$APPLY" MIGRATIONS="0090"); rc=$?
[ $rc = 0 ] && [ "$(applied)" = 4 ] && ! echo "$out" | grep -q "running the preflight" && ! echo "$out" | grep -q "all seven applied"
ok "C: 0090 alone — no second preflight, no postcheck" $?
out=$(run_step "$APPLY" MIGRATIONS="0092"); [ $? != 0 ] && echo "$out" | grep -q "0091 is neither applied" && [ "$(applied)" = 4 ]
ok "skipping D (0092 before 0091) is refused, nothing applied" $?
out=$(run_step "$APPLY" MIGRATIONS="0091"); rc=$?
[ $rc = 0 ] && [ "$(applied)" = 5 ] && ! echo "$out" | grep -q "all seven applied"
ok "D: 0091 alone — applied, no postcheck yet" $?
out=$(run_step "$APPLY" MIGRATIONS="0092"); rc=$?
[ $rc = 0 ] && [ "$(applied)" = 6 ] && echo "$out" | grep -q "all seven applied; running the postcheck" && echo "$out" | grep -q "every required check ok"
ok "E: 0092 — applied, then the 0086–0091 postcheck runs and passes" $?
out=$(run_step "$APPLY" MIGRATIONS="0092"); rc=$?; [ "$(applied)" = 6 ]; ok "E again: nothing re-applied (rc=$rc)" $?
out=$(run_step "Release candidate 0086–0091 postcheck, read only (rc_postcheck)"); ok "rc_postcheck read-only after E" $?
echo "FAILS=$FAILS"; exit $FAILS
