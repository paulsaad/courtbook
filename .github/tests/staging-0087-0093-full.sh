#!/usr/bin/env bash
# The whole planned staging sequence in ONE continuous local rehearsal (overnight assignment of 26 Nov, priority 5):
# A (preflight) → B 0087 0088 0089 → C 0090 → D 0091 → E 0092 → 0093 alone, using the staging-db workflow's own step
# scripts against a scratch 0001–0086 database that carries staging-like state (an account being deleted with the
# retry worker's heartbeat, a pay-at-the-desk club, bookings). Never touches staging.
#
# Between every step it checks what the rollout must not break:
#   - the read-only actions (m86_worker_check, coords_audit, test_conflicts) run twice and change NOTHING (a hash of
#     every public table and of staging_meta is identical before and after);
#   - pay at the desk still works (book_at_desk, a repeated token returns the same booking, cancel) — in a rolled-back
#     transaction, so it leaves no trace;
#   - the retry worker can still find and claim the open deletion (deletions_due, claim_deletion) — rolled back too;
#   - no overlapping active bookings.
# And it forces a failure part way through B (0088 broken in a scratch copy of the tree): the run must stop with 0087
# applied and recorded, nothing of 0088, and the clean tree must then resume with "0088 0089" (no second preflight).
#   sudo -u postgres bash .github/tests/staging-0087-0093-full.sh
set -u
cd "$(dirname "$0")/../.."
ROOT=$PWD
S=courtbook_wffull; FAILS=0
export DB="postgresql:///$S" REF=localrehearsal GITHUB_SHA=0000000rehearsal
ok() { if [ "$2" = 0 ]; then echo "ok    $1"; else echo "FAIL  $1"; FAILS=$((FAILS+1)); fi; }
BROKEN=$(mktemp -d)
trap 'psql -q -d postgres -c "drop database if exists $S" >/dev/null 2>&1; rm -rf "$BROKEN"' EXIT
step() { python3 -c "import sys,yaml; w=yaml.safe_load(open('$ROOT/.github/workflows/staging-db.yml')); r=[s['run'] for j in w['jobs'].values() for s in j['steps'] if s.get('name')==sys.argv[1]]; assert len(r)==1, sys.argv[1]; print(r[0])" "$1"; }
run_step() { local name=$1; shift; env "$@" bash -e -c "$(step "$name")" 2>&1; }
sql() { psql -X -At -d $S -v ON_ERROR_STOP=1 -c "$1"; }
applied() { sql "select string_agg(left(name, 4), ' ' order by name) from staging_meta.applied where name ~ '^00(8[7-9]|9[0-3])_'"; }
# a hash of every row of every public table and of staging_meta: any write anywhere changes it
fingerprint() {
  local q; q=$(sql "select string_agg(format('select %L || md5(coalesce(string_agg(t::text, %L order by t::text), %L)) from %I.%I t', n.nspname || '.' || c.relname, '|', '', n.nspname, c.relname), ' union all ')
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'r' and n.nspname in ('public', 'staging_meta')")
  psql -X -At -d $S -c "select md5(string_agg(x, ',' order by x)) from ($q) s(x)"
}

# ------------------------------------------------------------------ the scratch staging at 0001–0086, with state
psql -q -d postgres -c "drop database if exists $S" -c "create database $S" >/dev/null
psql -q -d $S -v ON_ERROR_STOP=1 -f supabase/tests/supabase_shim.sql >/dev/null || exit 2
sql "create schema staging_meta; create table staging_meta.applied (name text primary key, applied_at timestamptz not null default now(), sha text)" >/dev/null
for f in $(ls supabase/migrations/*.sql | sort); do
  n=$(basename "$f"); [ "${n:0:4}" \< 0087 ] || continue
  { cat "$f"; echo; echo "insert into staging_meta.applied (name) values ('$n');"; } | psql -q -d $S -v ON_ERROR_STOP=1 -1 >/dev/null 2>&1 || { echo "setup failed: $n"; exit 2; }
done
psql -q -d $S -v ON_ERROR_STOP=1 -f supabase/seed.sql >/dev/null || exit 2
P=f1000000-0000-4000-8000-000000000001; CLOSER=f1000000-0000-4000-8000-000000000002; STAFF=f1000000-0000-4000-8000-000000000003
psql -q -X -d $S -v ON_ERROR_STOP=1 >/dev/null <<SQL || { echo "state setup failed"; exit 2; }
insert into auth.users (id, phone) values ('$P', '+96171800001'), ('$CLOSER', '+96171800002'), ('$STAFF', '+96171800003');
update profiles set rules_accepted_at = now(), age_confirmed_at = now(), age_confirmed_via = 'app' where id in ('$P', '$CLOSER', '$STAFF');
-- a real club that takes payment at its desk (as the pilot clubs will)
insert into clubs (name, slug, payment_mode, service_fee_usd, is_demo) values ('Desk Club', 'desk-club', 'at_desk', 0, false);
insert into courts (club_id, name, sport) select id, 'Desk 1', 'padel' from clubs where slug = 'desk-club';
insert into price_rules (club_id, start_time, end_time, price_usd, label) select id, '08:00', '23:00', 25, 'all day' from clubs where slug = 'desk-club';
insert into club_staff (club_id, profile_id) select id, '$STAFF' from clubs where slug = 'desk-club';
-- an account being deleted, and the retry worker's last run (as on staging during the trial)
select close_account_internal('$CLOSER', 'web');
select record_deletion_worker_run('{"processed": 0}'::jsonb);
SQL
DESK_COURT=$(sql "select k.id from courts k join clubs c on c.id = k.club_id where c.slug = 'desk-club'")
DESK_CLUB=$(sql "select id from clubs where slug = 'desk-club'")

as_player() { printf '%s\n' "begin;" "set local role authenticated;" "set local request.jwt.claim.sub = '$1';" "$2" "rollback;" | psql -X -At -q -d $S 2>&1; }
as_service() { printf '%s\n' "begin;" "set local role service_role;" "$1" "rollback;" | psql -X -At -q -d $S 2>&1; }

checks() { # label
  local label=$1 before after out
  before=$(fingerprint)
  for a in "Deletion retry worker, read only (m86_worker_check)" "Club coordinates audit, read only (coords_audit)" "What occupies the old smoke/API test slots, read only (test_conflicts)"; do
    run_step "$a" >/dev/null 2>&1 || { echo "  (read-only action failed: $a)"; FAILS=$((FAILS+1)); }; run_step "$a" >/dev/null 2>&1
  done
  after=$(fingerprint)
  [ "$before" = "$after" ]; ok "$label: the read-only actions, run twice each, changed nothing" $?
  # pay at the desk: book, the same token again, cancel — all rolled back
  local tok s e
  tok=$(cat /proc/sys/kernel/random/uuid)
  s=$(sql "select ((current_date + 3)::timestamp + time '10:00') at time zone 'Asia/Beirut'"); e=$(sql "select ((current_date + 3)::timestamp + time '11:00') at time zone 'Asia/Beirut'")
  out=$(as_player $P "select booking_id || ' ' || already from book_at_desk('$DESK_COURT', '$s', '$e', '$tok');
    select booking_id || ' ' || already from book_at_desk('$DESK_COURT', '$s', '$e', '$tok');
    select count(*) from bookings where client_token = '$tok' and status = 'confirmed';
    select cancel_booking((select id from bookings where client_token = '$tok'), false);
    select status from bookings where client_token = '$tok';")
  local id1 id2
  id1=$(echo "$out" | sed -n 1p | cut -d' ' -f1); id2=$(echo "$out" | sed -n 2p)
  [ -n "$id1" ] && [ "$id2" = "$id1 true" ] && [ "$(echo "$out" | sed -n 3p)" = 1 ]
  ok "$label: pay at the desk books; the same token again returns the same booking (already)" $?
  [ "$(echo "$out" | tail -1)" = cancelled ]; ok "$label: the player cancels it (all rolled back)" $?
  # the retry worker still finds and claims the open deletion
  out=$(as_service "select count(*) from deletions_due(10) d(x) where x = '$CLOSER'; select (claim_deletion('$CLOSER', 300) ->> 'token' is not null or claim_deletion('$CLOSER', 300) is not null)::text;")
  [ "$(echo "$out" | tr '\n' ' ')" = "1 true " ]; ok "$label: the retry worker finds and claims the open deletion ($(echo "$out" | tr '\n' ' '))" $?
  [ "$(sql "select count(*) from bookings a join bookings b on a.court_id = b.court_id and a.id < b.id and a.status in ('pending','confirmed') and b.status in ('pending','confirmed') and tstzrange(a.start_at, a.end_at) && tstzrange(b.start_at, b.end_at)")" = 0 ]
  ok "$label: no overlapping active bookings" $?
  [ "$(fingerprint)" = "$after" ]; ok "$label: the checks themselves left nothing behind" $?
}

APPLY="Apply exactly the migrations named"
checks "at 0086"
out=$(run_step "Release candidate 0087–0092 preflight after 0086, read only (rc87_preflight)"); rc=$?; [ $rc = 0 ] || echo "$out" | grep -iE "fail|error" | head -5
ok "A: rc87_preflight passes with staging-like state" $rc
[ -n "${STOP_AFTER_A:-}" ] && exit 0

# ------------------------------------------------------------------ B, with a failure forced part way through
cp -r "$ROOT/.github" "$ROOT/supabase" "$BROKEN/"
f88=$(ls "$BROKEN"/supabase/migrations/0088_*.sql); echo "select 1/0;  -- forced failure (rehearsal)" >> "$f88"
pre=$(fingerprint)
out=$(cd "$BROKEN" && run_step "$APPLY" MIGRATIONS="0087 0088 0089"); rc=$?
[ $rc != 0 ] && echo "$out" | grep -q "0088_.* failed; it was rolled back and nothing after it was applied" && [ "$(applied)" = "0087" ] \
  && [ "$(sql "select to_regclass('public.player_areas') is null")" = t ]
ok "B (forced failure in 0088): the run stops; 0087 applied and recorded; nothing of 0088; the job says so" $?
out=$(run_step "$APPLY" MIGRATIONS="0088 0089"); rc=$?
[ $rc = 0 ] && [ "$(applied)" = "0087 0088 0089" ] && ! echo "$out" | grep -q "running the preflight"
ok "B resumes from the clean tree with '0088 0089' (no second preflight)" $?
checks "after B"
out=$(run_step "$APPLY" MIGRATIONS="0090"); [ $? = 0 ] && [ "$(applied)" = "0087 0088 0089 0090" ]; ok "C: 0090 applied" $?
checks "after C"
out=$(run_step "$APPLY" MIGRATIONS="0091"); [ $? = 0 ] && [ "$(applied)" = "0087 0088 0089 0090 0091" ]; ok "D: 0091 applied" $?
checks "after D"
out=$(run_step "$APPLY" MIGRATIONS="0092"); rc=$?
[ $rc = 0 ] && echo "$out" | grep -q "rc_0086_0091_postcheck.sql: every required check ok"; r=$?; [ $r = 0 ] || echo "$out" | grep -E "FAIL|error|ok$" | head -8
ok "E: 0092 applied; the 0086–0091 postcheck ran and passed" $r
checks "after E"
# the legal-page step (6c) is website-only: nothing to apply; the database must be unchanged by it — nothing to run
out=$(run_step "$APPLY" MIGRATIONS="0093"); rc=$?
[ $rc = 0 ] && [ "$(applied)" = "0087 0088 0089 0090 0091 0092 0093" ]; ok "0093 alone: preflight, applied, postcheck passed" $?
out=$(run_step "0093 (pilot) functional checks, one transaction rolled back (pilot_0093_functional)"); ok "0093 functional checks pass (rolled back)" $?
checks "after 0093"
# a closed account is refused at the desk after 0093 (the pilot's purpose), still rolled back
out=$(printf '%s\n' "begin;" "set local role authenticated;" "set local request.jwt.claim.sub = '$CLOSER';" \
  "select book_at_desk('$DESK_COURT', now() + interval '3 days', now() + interval '3 days 1 hour', gen_random_uuid());" "rollback;" | psql -X -At -q -d $S 2>&1)
echo "$out" | grep -q "account_closed"; r=$?; [ $r = 0 ] || echo "  got: $out"; ok "after 0093: the account being deleted is refused at the desk (account_closed)" $r
echo; echo "FAILS=$FAILS"; exit $FAILS
