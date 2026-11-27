#!/usr/bin/env bash
# Rehearses the staging-db.yml steps for 0.5.0's migrations 0099, 0100 and 0101 LOCALLY, running the workflow's own
# step scripts against a scratch database at 0001–0093 + the demo seed (where staging is since 27 Nov). Never touches
# staging. Run as the checkout's owner (the planted-0094 case writes a file into supabase/migrations for a moment):
#   PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=<local password> bash .github/tests/staging-050-steps.sh
set -u
cd "$(dirname "$0")/../.."
S=courtbook_wf050; FAILS=0
export DB="postgresql:///$S" REF=localrehearsal GITHUB_SHA=0000000rehearsal
ok() { if [ "$2" = 0 ]; then echo "ok    $1"; else echo "FAIL  $1"; FAILS=$((FAILS+1)); fi; }
PLANTED=supabase/migrations/0094_rehearsal_planted.sql
trap 'rm -f "$PLANTED"; psql -q -d postgres -c "drop database if exists $S" >/dev/null 2>&1' EXIT
step() { python3 -c "import sys,yaml; w=yaml.safe_load(open('.github/workflows/staging-db.yml')); r=[s['run'] for j in w['jobs'].values() for s in j['steps'] if s.get('name')==sys.argv[1]]; assert len(r)==1, sys.argv[1]; print(r[0])" "$1"; }
run_step() { local name=$1; shift; env "$@" bash -e -c "$(step "$name")" 2>&1; }
APPLY="Apply exactly the migrations named"
RO="0099 / 0100 / 0101 preflight or postcheck, read only"
UNDO="Undo ONE of 0101, 0100, 0099 (newest first), one transaction (undo_0099_0101)"
ro() { env bash -e -c "$(step "$RO" | sed "s/\${{ inputs.action }}/$1/")" 2>&1; }
applied() { psql -At -d $S -c "select coalesce(string_agg(left(name,4), ' ' order by name), '-') from staging_meta.applied where name >= '0093'"; }
fp() { psql -At -d $S -f supabase/tests/schema_fingerprint.sql | md5sum | cut -c1-12; }
psql -q -d postgres -c "drop database if exists $S" -c "create database $S" >/dev/null
psql -q -d $S -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql >/dev/null || exit 2
psql -q -d $S -c "create schema staging_meta; create table staging_meta.applied (name text primary key, applied_at timestamptz not null default now(), sha text)" >/dev/null
for f in $(ls supabase/migrations/*.sql | sort); do
  n=$(basename "$f"); [ "${n:0:4}" \< 0094 ] || continue
  { cat "$f"; echo; echo "insert into staging_meta.applied (name) values ('$n');"; } | psql -q -d $S -v ON_ERROR_STOP=1 -1 >/dev/null 2>&1 || { echo "setup failed: $n"; exit 2; }
done
psql -q -d $S -v ON_ERROR_STOP=1 -f supabase/seed.sql >/dev/null || exit 2
base=$(fp)
echo "start: 0001–0093 + seed (applied from 0093: $(applied)); schema $base"

# read-only checks before anything
out=$(ro f1_0099_preflight); ok "f1_0099_preflight passes at 0093" $?
out=$(ro f1_0099_postcheck); [ $? != 0 ]; ok "f1_0099_postcheck fails before 0099" $?
out=$(ro photos_0101_postcheck); [ $? != 0 ]; ok "photos_0101_postcheck fails before 0101" $?
[ "$(fp)" = "$base" ]; ok "read-only checks changed nothing" $?

# payments (0094–0098) can never be applied
out=$(run_step "$APPLY" MIGRATIONS="0094"); [ $? != 0 ] && [ "$(applied)" = 0093 ]; ok "apply 0094 refused (no such file on this branch); nothing applied" $?
echo "select 1;" > "$PLANTED"; chmod 644 "$PLANTED"
out=$(run_step "$APPLY" MIGRATIONS="0099"); rc=$?; rm -f "$PLANTED"
[ $rc != 0 ] && echo "$out" | grep -q "payment migration (0094–0098) is on this branch" && [ "$(applied)" = 0093 ] && [ "$(fp)" = "$base" ]
ok "a 0094–0098 file on the branch blocks every apply, even 0099; nothing applied" $?
psql -q -d $S -c "insert into staging_meta.applied (name) values ('0095_recorded_elsewhere.sql')" >/dev/null
out=$(run_step "$APPLY" MIGRATIONS="0099"); rc=$?
psql -q -d $S -c "delete from staging_meta.applied where name = '0095_recorded_elsewhere.sql'" >/dev/null
[ $rc != 0 ] && echo "$out" | grep -q "payment migration is recorded as applied" && [ "$(applied)" = 0093 ]
ok "a recorded 0094–0098 blocks every apply; nothing applied" $?

# one at a time, in order
out=$(run_step "$APPLY" MIGRATIONS="0099 0100"); [ $? != 0 ] && echo "$out" | grep -q "one at a time" && [ "$(applied)" = 0093 ]; ok "0099 and 0100 together refused" $?
out=$(run_step "$APPLY" MIGRATIONS="0100"); [ $? != 0 ] && echo "$out" | grep -q "needs the previous step" && [ "$(applied)" = 0093 ]; ok "0100 before 0099 refused" $?
out=$(run_step "$APPLY" MIGRATIONS="0101"); [ $? != 0 ] && [ "$(applied)" = 0093 ]; ok "0101 before 0100 refused" $?
out=$(run_step "$APPLY" MIGRATIONS="0099,0093"); [ $? != 0 ] && [ "$(applied)" = 0093 ] && [ "$(fp)" = "$base" ]; ok "0099 with an applied number refused; schema unchanged" $?

# a preflight STOP applies nothing (forced with a check file that always STOPs)
F=$(mktemp /tmp/pre050.XXXXXX.sql); chmod 644 "$F"; echo "select 'forced stop (rehearsal)', '', 'STOP'" > "$F"
out=$(env MIGRATIONS="0099" bash -e -c "$(step "$APPLY" | sed "s|supabase/live/staff_moves_preflight.sql|$F|")" 2>&1); rc=$?; rm -f "$F"
[ $rc != 0 ] && echo "$out" | grep -q "0099 preflight failed: nothing was applied" && [ "$(applied)" = 0093 ] && [ "$(fp)" = "$base" ]
ok "a preflight STOP: nothing applied, schema unchanged" $?

# the three, in order
out=$(run_step "$APPLY" MIGRATIONS="0099"); rc=$?
[ $rc = 0 ] && echo "$out" | grep -q "0099: running the preflight" && echo "$out" | grep -q "staff_moves_postcheck.sql: every required check ok" && [ "$(applied)" = "0093 0099" ]
ok "apply 0099: preflight, applied, postcheck passed, recorded" $?; [ $rc = 0 ] || echo "$out" | tail -8
out=$(run_step "$APPLY" MIGRATIONS="0099"); [ $? != 0 ] && echo "$out" | grep -q "already applied"; ok "0099 again refused" $?
out=$(ro f1_0099_postcheck); ok "f1_0099_postcheck passes" $?
out=$(ro sports_0100_preflight); ok "sports_0100_preflight passes after 0099" $?
s99=$(fp)
out=$(run_step "$APPLY" MIGRATIONS="0100"); rc=$?
[ $rc = 0 ] && echo "$out" | grep -q "sports_0100_postcheck.sql: every required check ok" && [ "$(applied)" = "0093 0099 0100" ]
ok "apply 0100: preflight, applied, postcheck passed" $?; [ $rc = 0 ] || echo "$out" | tail -8
s100=$(fp)
out=$(ro photos_0101_preflight); ok "photos_0101_preflight passes after 0100" $?
out=$(run_step "$APPLY" MIGRATIONS="0101"); rc=$?
[ $rc = 0 ] && echo "$out" | grep -q "photos_0101_postcheck.sql: every required check ok" && [ "$(applied)" = "0093 0099 0100 0101" ]
ok "apply 0101: preflight, applied, postcheck passed" $?; [ $rc = 0 ] || echo "$out" | tail -8
s101=$(fp)
out=$(ro photos_0101_preflight); [ $? != 0 ]; ok "photos_0101_preflight STOPs once 0101 is applied" $?
for c in f1_0099_postcheck sports_0100_postcheck photos_0101_postcheck; do out=$(ro $c); ok "$c passes at 0101" $?; done

# undo: guards, then newest first back to the 0093 schema exactly
out=$(run_step "$UNDO" CONFIRM=wrong MIGRATIONS=0101); [ $? != 0 ] && [ "$(fp)" = "$s101" ]; ok "undo with a wrong confirm_ref refused; nothing changed" $?
out=$(run_step "$UNDO" CONFIRM=$REF MIGRATIONS=0099); [ $? != 0 ] && echo "$out" | grep -q "undo them first" && [ "$(fp)" = "$s101" ]; ok "undo 0099 while 0100/0101 applied refused; nothing changed" $?
out=$(run_step "$UNDO" CONFIRM=$REF MIGRATIONS="0094"); [ $? != 0 ] && [ "$(fp)" = "$s101" ]; ok "undo of any other number refused" $?
P1=5a0e0050-0000-4000-8000-000000000001
psql -q -d $S -v ON_ERROR_STOP=1 <<SQL >/dev/null 2>&1
insert into auth.users (id, email) values ('$P1', 'wf050@courtbook.test');
SQL
# a valid stored photo: RIFF....WEBP header, 64 bytes, 64x64 (as the server writes them)
psql -q -d $S -c "insert into player_photos (profile_id, image, width, height) values ('$P1', '\\x52494646'::bytea || '\\x00000000'::bytea || '\\x57454250'::bytea || decode(repeat('00', 52), 'hex'), 64, 64)" >/dev/null 2>&1
nph=$(psql -At -d $S -c "select count(*) from player_photos")
if [ "$nph" -ge 1 ] 2>/dev/null; then
  out=$(run_step "$UNDO" CONFIRM=$REF MIGRATIONS=0101); [ $? != 0 ] && echo "$out" | grep -q "rollback_blocked" && [ "$(applied)" = "0093 0099 0100 0101" ] && [ "$(psql -At -d $S -c "select count(*) from player_photos")" = "$nph" ]
  ok "undo 0101 while a photo is stored: refused by 0101_down (the workflow never confirms discarding); nothing changed" $?
  psql -q -d $S -c "delete from player_photos" >/dev/null
else
  echo "FAIL  (setup) could not store a test photo"; FAILS=$((FAILS+1))
fi
psql -q -d $S -c "delete from profiles where id='$P1'; delete from auth.users where id='$P1'" >/dev/null 2>&1
out=$(run_step "$UNDO" CONFIRM=$REF MIGRATIONS=0101); [ $? = 0 ] && [ "$(applied)" = "0093 0099 0100" ] && [ "$(fp)" = "$s100" ]; ok "undo 0101: schema exactly as after 0100" $?
out=$(run_step "$UNDO" CONFIRM=$REF MIGRATIONS=0100); [ $? = 0 ] && [ "$(applied)" = "0093 0099" ] && [ "$(fp)" = "$s99" ]; ok "undo 0100: schema exactly as after 0099" $?
out=$(run_step "$UNDO" CONFIRM=$REF MIGRATIONS=0099); [ $? = 0 ] && [ "$(applied)" = "0093" ] && [ "$(fp)" = "$base" ]; ok "undo 0099: schema exactly as at 0093 (staging today)" $?
out=$(ro f1_0099_preflight); ok "f1_0099_preflight passes again after the undo" $?

# roll forward again, then a postcheck that fails AFTER the commit says the migration IS applied
for m in 0099 0100; do out=$(run_step "$APPLY" MIGRATIONS="$m"); ok "re-apply $m" $?; done
F=$(mktemp /tmp/pc050.XXXXXX.sql); chmod 644 "$F"; echo "select 'forced failure (rehearsal)', '', 'STOP'" > "$F"
out=$(env MIGRATIONS="0101" bash -e -c "$(step "$APPLY" | sed "s|supabase/live/photos_0101_postcheck.sql|$F|")" 2>&1); rc=$?; rm -f "$F"
[ $rc != 0 ] && echo "$out" | grep -q "0101 IS APPLIED" && [ "$(applied)" = "0093 0099 0100 0101" ] && [ "$(fp)" = "$s101" ]
ok "a postcheck failure after the commit: the job fails and says 0101 IS APPLIED (recorded); schema as a normal 0101" $?

echo; [ $FAILS = 0 ] && echo "STAGING 0.5.0 WORKFLOW REHEARSAL: PASS" || echo "STAGING 0.5.0 WORKFLOW REHEARSAL: $FAILS FAILED"
exit $((FAILS > 0))
