#!/usr/bin/env bash
# Rehearses the 0085 staging rollout on a LOCAL disposable database at the launch-1 state (0001–0084 + seed), running
# the REAL staging-db.yml step scripts (apply with its 0085 gate, m85_preflight/postcheck, m7_demo_hidden_on/off).
#   PSQL="sudo -u postgres psql" bash supabase/tests/m85/rehearsal.sh
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}; DBN=courtbook_m85_rehearsal
oks=0; fails=0
rep() { if [ "$2" = true ]; then echo "ok    $1"; oks=$((oks+1)); else echo "FAIL  $1  [$3]"; fails=$((fails+1)); fi; }
P() { $PSQL -X -q -At -d $DBN "$@"; }
WT=$(mktemp -d); cp -r .github supabase "$WT"/; chmod -R a+rX "$WT"; trap 'rm -rf "$WT"' EXIT
step() { local action=$1 nth=$2; shift 2; python3 supabase/tests/launch1/step.py "$action" "$nth" > /tmp/m85_step.sh
  (cd "$WT" && sudo -u postgres env DB="dbname=$DBN" GITHUB_SHA=rehearsal0 "$@" bash -e /tmp/m85_step.sh) > /tmp/m85_step.out 2>&1; }
applied() { P -c "select count(*) from staging_meta.applied where name like '0085_%'"; }
$PSQL -q -d postgres -c "drop database if exists $DBN" -c "create database $DBN" >/dev/null 2>&1
P -f supabase/tests/supabase_shim.sql >/dev/null 2>&1
P -c "create schema staging_meta; create table staging_meta.applied (name text primary key, sha text, applied_at timestamptz default now())" >/dev/null
for f in $(ls supabase/migrations/*.sql | sort | awk -F/ '$NF < "0085"'); do
  { cat "$f"; echo; echo "insert into staging_meta.applied (name, sha) values ('$(basename $f)', 'rehearsal');"; } | P -v ON_ERROR_STOP=1 -1 >/dev/null 2>&1 || { echo "cannot build: $f"; exit 2; }
done
P -v ON_ERROR_STOP=1 -f supabase/seed.sql >/dev/null 2>&1 || { echo "cannot seed"; exit 2; }
# an unpublished club with a player's past booking, as staging may have after club set-up
P -c "insert into auth.users (id, phone) values ('d8510000-0000-4000-8000-000000000001', '+96178510001');
      insert into clubs (name, slug, is_demo, active, payment_mode) values ('R85 hidden', 'r85-hidden', false, false, 'at_desk');
      insert into courts (club_id, name, sport) select id, 'R85 court', 'padel' from clubs where slug = 'r85-hidden';
      insert into clubs (name, slug, is_demo, active, payment_mode) values ('R85 demo draft', 'r85-demo-draft', true, false, 'simulated');
      insert into courts (club_id, name, sport) select id, 'R85 demo court', 'padel' from clubs where slug = 'r85-demo-draft';" >/dev/null
# visitors' view of the unpublished demo club and its court (no signed-in user, as the checks run)
draft_seen() { P -c "select ((select count(*) from clubs where slug = 'r85-demo-draft' and club_readable_by_me(id, is_demo)) + (select count(*) from courts k join clubs c on c.id = k.club_id where c.slug = 'r85-demo-draft' and club_id_readable_by_me(k.club_id)))::text"; }
switch() { P -c "select coalesce((select value from app_settings where key = 'hide_demo_clubs'), 'not set')"; }
step m7_demo_hidden_on 1; rc=$?
rep "Q0 before 0085, with an unpublished demo club present: demo switch on passes" "$([ $rc = 0 ] && echo true)" "rc $rc $(grep -E 'FAIL' /tmp/m85_step.out | head -2)"
step m7_demo_hidden_off 1; rc=$?
rep "Q0 ...and off passes (the 0085 row is information only before 0085)" "$([ $rc = 0 ] && grep -q 'before 0085: not applicable' /tmp/m85_step.out && echo true)" "rc $rc $(grep -E 'FAIL' /tmp/m85_step.out | head -2)"

step m85_preflight 1; rep "Q1 m85_preflight passes at the launch-1 state" "$([ $? = 0 ] && echo true)" "$(grep FAIL /tmp/m85_step.out | head -2)"
P -c "insert into app_settings (key, value) values ('require_age_confirmation', 'true') on conflict (key) do update set value = 'true'" >/dev/null
step apply 2 MIGRATIONS="0085"; rc=$?
rep "Q2 apply 0085 with a failing preflight: refused, nothing applied" "$([ $rc != 0 ] && [ "$(applied)" = 0 ] && grep -q '0085 preflight failed: nothing was applied' /tmp/m85_step.out && echo true)" "rc $rc applied $(applied)"
P -c "update app_settings set value = 'false' where key = 'require_age_confirmation'" >/dev/null
rep "Q3 before 0085: visitors can read the unpublished club (the gap 0085 closes)" "$([ "$(P -c "select club_readable_by_me(id, is_demo) from clubs where slug = 'r85-hidden'")" = t ] && echo true)" ""
step apply 2 MIGRATIONS="0085"; rc=$?
rep "Q4 apply 0085: preflight, 1 applied, seed, postcheck run by the job and ok" "$([ $rc = 0 ] && [ "$(applied)" = 1 ] && grep -q '0085_postcheck.sql: every required check ok' /tmp/m85_step.out && echo true)" "rc $rc applied $(applied) $(grep -E 'FAIL|::error' /tmp/m85_step.out | head -3)"
rep "Q5 after 0085: visitors cannot read the unpublished club" "$([ "$(P -c "select club_readable_by_me(id, is_demo) from clubs where slug = 'r85-hidden'")" = f ] && echo true)" ""
step m85_postcheck 1; rep "Q6 m85_postcheck passes" "$([ $? = 0 ] && echo true)" "$(grep FAIL /tmp/m85_step.out | head -2)"
step m85_preflight 1; rep "Q7 m85_preflight now fails (already applied)" "$([ $? != 0 ] && echo true)" ""
step m7_demo_hidden_on 1; rc=$?
rep "Q8 demo switch on: check passes with unpublished clubs (demo and not) present; the unpublished demo club stays unreadable" "$([ $rc = 0 ] && [ "$(switch)" = true ] && [ "$(draft_seen)" = 0 ] && grep -q 'unpublished demo clubs and their courts are never readable.*readable: 0' /tmp/m85_step.out && echo true)" "rc $rc seen $(draft_seen) $(grep -E 'FAIL' /tmp/m85_step.out | head -2)"
step m7_demo_hidden_off 1; rc=$?
rep "Q9 demo switch off: check passes, switch off, the unpublished demo club still unreadable" "$([ $rc = 0 ] && [ "$(switch)" = false ] && [ "$(draft_seen)" = 0 ] && echo true)" "rc $rc seen $(draft_seen) $(grep -E 'FAIL' /tmp/m85_step.out | head -2)"
# if a later change exposed unpublished demo clubs while the switch is off, the demo-switch action must fail and put the
# switch back: a copy of the 0085 rule that forgets "published" for demo clubs only
P -c "create or replace function club_visible_to_me(p_club uuid, p_is_demo boolean) returns boolean language sql stable security definer set search_path = public as \$\$
  select (coalesce((select c.active or c.is_demo from clubs c where c.id = p_club), false)            -- 0085: published only (mutated)
          and (not coalesce(p_is_demo, false) or not demo_clubs_hidden()))
      or (auth.uid() is not null and (is_staff_of(p_club) or is_admin())); \$\$" >/dev/null
step m7_demo_hidden_off 1; rc=$?
rep "Q9b ...if the unpublished demo club were exposed with the switch off, the action fails and names it; the switch stays off" "$([ $rc != 0 ] && [ "$(switch)" = false ] && grep -q 'FAIL.*unpublished demo clubs and their courts are never readable' /tmp/m85_step.out && echo true)" "rc $rc switch $(switch)"
P -f supabase/migrations/0085_unpublished_clubs_private.sql >/dev/null
P -c "create or replace function club_visible_to_me(p_club uuid, p_is_demo boolean) returns boolean language sql stable security definer set search_path = public as \$\$ select true \$\$" >/dev/null
step m85_postcheck 1; rep "Q10 m85_postcheck fails the job if the rule is undone" "$([ $? != 0 ] && echo true)" ""
step apply 2 MIGRATIONS="0085"; rc=$?
rep "Q11 apply 0085 again: nothing pending, nothing done" "$([ "$(applied)" = 1 ] && echo true)" "rc $rc"
$PSQL -q -d postgres -c "drop database if exists $DBN" >/dev/null 2>&1
echo "summary: $oks ok, $fails FAIL"; [ $fails = 0 ] && echo "RESULT: PASS" || { echo "RESULT: FAIL"; exit 1; }
