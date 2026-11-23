#!/usr/bin/env bash
# Release safety audit — automated checks (docs/audit/release-readiness.md).
#
# LOCAL DISPOSABLE DATABASES ONLY. Builds `courtbook_audit` from the live-equivalent migrations
# (build_db.sh, default origin/mobile-m2-native = 0001–0066), runs:
#   1. catalog checks   — RLS, grants, security-definer hygiene, anonymous surface (regression guard)
#   2. role checks      — what players and staff can and cannot do, in one rolled-back transaction
#   3. race checks      — two real sessions, in a scratch copy `courtbook_audit_race` (dropped after)
#   4. invariants       — booking/payment consistency over everything the races created
# Result per check: ok | FAIL | KNOWN <finding> (expected to fail until that finding is fixed) |
# XPASS <finding> (a known finding now passes: update this script and the report).
# Exit 0 only when there is no FAIL and no XPASS.
#   PSQL="sudo -u postgres psql" bash supabase/tests/audit/run_audit.sh [ref]
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
DB=courtbook_audit
RACE=courtbook_audit_race
REF=${1:-origin/mobile-m2-native}
bash supabase/tests/audit/build_db.sh "$REF" || exit 2
# A finding is expected to pass on a schema that contains its fix (docs/audit/fixes.md), and to be a
# KNOWN finding on one that does not (e.g. the live-equivalent default ref).
src_has() { if [ "$REF" = WORKTREE ]; then ls supabase/migrations/"$1"_*.sql >/dev/null 2>&1
            else git ls-tree --name-only "$REF" supabase/migrations/ | grep -q "/$1_"; fi; }
fixed_by() { if src_has "$1"; then echo pass; else echo "known:$2"; fi; }
R2=$(fixed_by 0068 R2); S1=$(fixed_by 0069 S1); S5=$(fixed_by 0069 S5); D1=$(fixed_by 0070 D1); D3=$(fixed_by 0071 D3)
MATCHES_DELETE=$([ "$S1" = pass ] || echo "matches.DELETE,")  # S1 removes that policy
echo "== expectations for this schema: R2 $R2, S1 $S1, S5 $S5, D1 $D1, D3 $D3"

fails=0; xpass=0; known=0; oks=0
report() { # id, pass(t/f), expectation(pass|known:<F>), detail
  local id=$1 pass=$2 exp=$3 detail=${4:-}
  if [ "$exp" = pass ]; then
    if [ "$pass" = t ]; then echo "ok    $id"; oks=$((oks+1)); else echo "FAIL  $id  [$detail]"; fails=$((fails+1)); fi
  else
    local f=${exp#known:}
    if [ "$pass" = t ]; then echo "XPASS $id  ($f appears fixed — update the audit)"; xpass=$((xpass+1)); else echo "KNOWN $id  ($f) [$detail]"; known=$((known+1)); fi
  fi
}

# ---------------------------------------------------------------- 1 + 2: one rolled-back transaction
P1=a0000000-0000-4000-8000-0000000000a1; P2=a0000000-0000-4000-8000-0000000000a2
SA=a0000000-0000-4000-8000-0000000000b1; SB=a0000000-0000-4000-8000-0000000000b2; CO=a0000000-0000-4000-8000-0000000000c1
AT() { echo "(current_date + $1 + time '$2') at time zone 'Asia/Beirut'"; }
out=$({
cat <<SQL
\\set ON_ERROR_STOP 1
begin;
create temp table r (id text, pass boolean, exp text, detail text);
grant all on r to authenticated, anon;

-- ===== 1. catalog =====
insert into r select 'CAT1 every public table has row-level security on',
  count(*) = 0, 'pass', string_agg(c.relname, ',') from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r','p') and not c.relrowsecurity;
insert into r select 'CAT2 every security-definer function pins its search_path',
  count(*) = 0, 'pass', string_agg(p.proname, ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) x where x like 'search_path=%');
insert into r select 'CAT3 no security-definer function is executable by PUBLIC (default grant)',
  count(*) = 0, 'pass', string_agg(p.proname, ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
insert into r select 'CAT4 anonymous visitors cannot write any public table',
  count(*) = 0, 'pass', string_agg(distinct table_name || ':' || privilege_type, ',') from information_schema.column_privileges
  where grantee = 'anon' and table_schema = 'public' and privilege_type in ('INSERT','UPDATE','DELETE');
insert into r select 'CAT4b ... nor hold table-level write, truncate or trigger privileges',
  count(*) = 0, 'pass', string_agg(table_name || ':' || privilege_type, ',') from information_schema.table_privileges
  where grantee = 'anon' and table_schema = 'public' and privilege_type <> 'SELECT';
-- 0078 (M7): club_readable_by_me, club_id_readable_by_me, club_id_visible_to_me added (RLS helpers, boolean only); clubs admin, courts staff and price_rules staff FOR ALL split into INSERT/UPDATE/DELETE
insert into r select 'CAT5 anonymous visitors can run exactly the public-browse functions',
  string_agg(p.proname, ',' order by p.proname) = 'areas,club_day_slots,club_discovery,club_id_readable_by_me,club_id_visible_to_me,club_readable_by_me,club_sports,next_free_slot,quote_price', 'pass',
  string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute');
insert into r select 'CAT6 anonymous visitors can read nothing from personal or money tables',
  count(*) = 0, 'pass', string_agg(distinct table_name, ',') from information_schema.column_privileges
  where grantee = 'anon' and table_schema = 'public' and privilege_type = 'SELECT'
    and table_name in ('bookings','payments','profiles','credit_transactions','club_payouts','notifications','match_messages',
                       'match_players','matches','player_levels','club_staff','blocks','coaches','coach_clubs','availability_rules','availability_exceptions');
-- Any new client write path must be reviewed: the exact set of write policies is pinned here.
insert into r select 'CAT7 write policies are exactly the reviewed set (a new one must be reviewed and added here)',
  string_agg(tablename || '.' || cmd, ',' order by tablename, cmd, policyname) =
  'availability_exceptions.ALL,availability_rules.ALL,blocks.DELETE,bookings.DELETE,club_staff.ALL,clubs.DELETE,clubs.INSERT,clubs.UPDATE,coach_clubs.DELETE,coach_clubs.INSERT,coaches.DELETE,coaches.INSERT,coaches.UPDATE,courts.DELETE,courts.INSERT,courts.UPDATE,credit_packs.ALL,credit_transactions.INSERT,districts.ALL,governorates.ALL,match_messages.INSERT,${MATCHES_DELETE}notifications.UPDATE,price_rules.DELETE,price_rules.INSERT,price_rules.UPDATE,profiles.UPDATE,sports.ALL,towns.ALL',
  'pass', string_agg(tablename || '.' || cmd, ',' order by tablename, cmd, policyname)
  from pg_policies where schemaname = 'public' and cmd in ('INSERT','UPDATE','DELETE','ALL');
insert into r select 'CAT8 bookings and payments have no client write policy (all writes go through checked functions)',
  count(*) = 0, 'pass', string_agg(tablename || '.' || policyname, ',') from pg_policies
  where tablename in ('bookings','payments') and cmd in ('INSERT','UPDATE','ALL');
-- known findings carried from the M3 review, pinned so they show up here until fixed
insert into r select 'CAT9 players can update only notifications.read_at (M3 finding S5)',
  not exists (select 1 from information_schema.column_privileges where grantee = 'authenticated' and table_name = 'notifications'
              and privilege_type = 'UPDATE' and column_name <> 'read_at'), '$S5', '';
insert into r select 'CAT10 the organiser has no direct DELETE on matches (M3 finding S1)',
  not exists (select 1 from pg_policies where tablename = 'matches' and cmd = 'DELETE'), '$S1', '';

-- ===== 2. roles =====
insert into auth.users (id, email) values ('$P1','p1@audit.test'), ('$P2','p2@audit.test'), ('$SA','sa@audit.test'), ('$SB','sb@audit.test'), ('$CO','co@audit.test');
insert into clubs (name, slug) values ('Audit Other Club', 'audit-other');
insert into courts (club_id, name, sport) select id, 'Other 1', 'padel' from clubs where slug = 'audit-other';
insert into club_staff (club_id, profile_id) select id, '$SA' from clubs where slug = 'batroun';
insert into club_staff (club_id, profile_id) select id, '$SB' from clubs where slug = 'audit-other';
insert into blocks (club_id, court_id, start_at, end_at, reason, created_by)
  select k.club_id, k.id, $(AT 3 10:00), $(AT 3 11:00), 'Private lesson — Ahmad H. 03 123 456', '$SA' from courts k where k.name = 'Padel 3';

set role authenticated; select set_config('request.jwt.claim.sub', '$P1', false) \\g /dev/null
create temp table h as select * from hold_slot((select id from clubs where slug = 'batroun'), (select id from courts where name = 'Padel 1'), $(AT 2 18:00), $(AT 2 19:30), gen_random_uuid());
update profiles set roles = '{player,admin}' where id = '$P1';
insert into r select 'PRIV1 a player cannot make themselves admin', (select roles from profiles where id = '$P1') = '{player}', 'pass', (select roles::text from profiles where id = '$P1');
do \$\$ begin update profiles set id = 'a0000000-0000-4000-8000-0000000000ff' where id = '$P1'; insert into r values ('PRIV2 a player cannot change their profile id', false, 'pass', 'allowed');
exception when others then insert into r values ('PRIV2 a player cannot change their profile id', true, 'pass', sqlerrm); end \$\$;
do \$\$ begin insert into bookings (club_id, court_id, player_id, start_at, end_at, status, source, created_by)
  values ((select id from clubs where slug = 'batroun'), (select id from courts where name = 'Padel 2'), '$P1', $(AT 5 10:00), $(AT 5 11:00), 'confirmed', 'app', '$P1');
  insert into r values ('PRIV3 a player cannot insert a booking directly', false, 'pass', 'allowed');
exception when others then insert into r values ('PRIV3 a player cannot insert a booking directly', true, 'pass', sqlerrm); end \$\$;
with u as (update bookings set status = 'confirmed', hold_expires_at = null where id = (select booking_id from h) returning 1)
insert into r select 'PRIV4 a player cannot confirm their own hold by updating it', count(*) = 0, 'pass', count(*)::text || ' row(s) changed' from u;
with u as (update payments set status = 'paid', paid_at = now() where id = (select payment_id from h) returning 1)
insert into r select 'PRIV5 a player cannot mark their own payment paid', count(*) = 0, 'pass', count(*)::text || ' row(s) changed' from u;
do \$\$ begin perform confirm_payment((select payment_id from h), 'SIM-X', 31); insert into r values ('PRIV6 a player cannot call confirm_payment', false, 'pass', 'allowed');
exception when insufficient_privilege then insert into r values ('PRIV6 a player cannot call confirm_payment', true, 'pass', sqlerrm); end \$\$;
do \$\$ begin perform staff_book((select id from clubs where slug = 'batroun'), (select id from courts where name = 'Padel 2'), $(AT 5 12:00), $(AT 5 13:00), 'Me', null);
  insert into r values ('PRIV7 a player cannot make a desk booking', false, 'pass', 'allowed');
exception when others then insert into r values ('PRIV7 a player cannot make a desk booking', sqlerrm = 'forbidden', 'pass', sqlerrm); end \$\$;
insert into r select 'PRIV8 a player cannot read the free-text reason of club blocks', coalesce(max(reason), '') = '', '$R2', coalesce(max(reason), 'none') from blocks;
insert into r select 'PRIV8b ... nor which staff member created them', coalesce(max(created_by::text), '') = '', '$R2', coalesce(max(created_by::text), 'none') from blocks;
reset role;

set role authenticated; select set_config('request.jwt.claim.sub', '$P2', false) \\g /dev/null
insert into r select 'PRIV9 another player sees none of my bookings, payments or profile',
  (select count(*) from bookings where player_id = '$P1') + (select count(*) from payments where profile_id = '$P1') + (select count(*) from profiles where id = '$P1') = 0, 'pass', '';
do \$\$ begin perform cancel_booking((select booking_id from h), false); insert into r values ('PRIV10 another player cannot cancel my booking', false, 'pass', 'allowed');
exception when others then insert into r values ('PRIV10 another player cannot cancel my booking', true, 'pass', sqlerrm); end \$\$;
reset role;

-- staff of another club
set role authenticated; select set_config('request.jwt.claim.sub', '$SA', false) \\g /dev/null
create temp table w as select staff_book((select id from clubs where slug = 'batroun'), (select id from courts where name = 'Padel 2'), $(AT 4 10:00), $(AT 4 11:00), 'Walk-in Rami', '03 000 000') as id;
reset role;
set role authenticated; select set_config('request.jwt.claim.sub', '$SB', false) \\g /dev/null
insert into r select 'PRIV11 staff of another club see none of this club''s bookings or payments',
  (select count(*) from bookings where club_id = (select id from clubs where slug = 'batroun')) + (select count(*) from payments where club_id = (select id from clubs where slug = 'batroun')) = 0, 'pass', '';
do \$\$ begin perform staff_book((select id from clubs where slug = 'batroun'), (select id from courts where name = 'Padel 2'), $(AT 5 14:00), $(AT 5 15:00), 'X', null);
  insert into r values ('PRIV12 staff of another club cannot book here', false, 'pass', 'allowed');
exception when others then insert into r values ('PRIV12 staff of another club cannot book here', sqlerrm = 'forbidden', 'pass', sqlerrm); end \$\$;
do \$\$ begin perform move_booking((select id from w), (select id from courts where name = 'Padel 3'), $(AT 4 12:00), $(AT 4 13:00));
  insert into r values ('PRIV13 staff of another club cannot move this club''s booking', false, 'pass', 'allowed');
exception when others then insert into r values ('PRIV13 staff of another club cannot move this club''s booking', sqlerrm = 'forbidden', 'pass', sqlerrm); end \$\$;
do \$\$ begin perform cancel_booking((select id from w), true); insert into r values ('PRIV14 staff of another club cannot cancel this club''s booking', false, 'pass', 'allowed');
exception when others then insert into r values ('PRIV14 staff of another club cannot cancel this club''s booking', true, 'pass', sqlerrm); end \$\$;
do \$\$ begin update courts set active = false where name = 'Padel 1'; insert into r select 'PRIV15 staff of another club cannot change this club''s courts', (select active from courts where name = 'Padel 1'), 'pass', '';
exception when others then insert into r values ('PRIV15 staff of another club cannot change this club''s courts', true, 'pass', sqlerrm); end \$\$;
reset role;

-- a coach can't list themselves without a club's approval
set role authenticated; select set_config('request.jwt.claim.sub', '$CO', false) \\g /dev/null
insert into coaches (profile_id, sports, price_usd, active) values ('$CO', '{padel}', 20, true);
reset role;
set role authenticated; select set_config('request.jwt.claim.sub', '$P2', false) \\g /dev/null
insert into r select 'PRIV16 a self-registered coach is invisible to players until a club approves', count(*) = 0, 'pass', count(*)::text
  from coaches where profile_id = '$CO';
reset role;

-- ===== booking rules worth pinning =====
update bookings set hold_expires_at = now() - interval '1 minute' where id = (select booking_id from h);
set role authenticated; select set_config('request.jwt.claim.sub', '$SA', false) \\g /dev/null
do \$\$ begin perform move_booking((select id from w), (select id from courts where name = 'Padel 1'), $(AT 2 18:00), $(AT 2 19:30));
  insert into r select 'BOOK1 a staff move onto an expired (unswept) hold succeeds and the hold is expired', (select status from bookings where id = (select booking_id from h)) = 'expired', 'pass', '';
exception when others then insert into r values ('BOOK1 a staff move onto an expired (unswept) hold succeeds and the hold is expired', false, 'pass', sqlerrm); end \$\$;
do \$\$ begin perform staff_book((select id from clubs where slug = 'batroun'), (select id from courts where name = 'Padel 2'), $(AT -1 10:00), $(AT -1 11:00), 'Past', null);
  insert into r values ('BOOK2 a desk booking that started more than 2 hours ago is refused (decision D3)', false, '$D3', 'allowed');
exception when others then insert into r values ('BOOK2 a desk booking that started more than 2 hours ago is refused (decision D3)', sqlerrm = 'walk_in_too_old', '$D3', sqlerrm); end \$\$;
reset role;
insert into r select 'BOOK3 new clubs default to taking payment at the desk (decision D1)', (select column_default from information_schema.columns where table_name = 'clubs' and column_name = 'payment_mode') not like '%simulated%', '$D1', (select column_default from information_schema.columns where table_name = 'clubs' and column_name = 'payment_mode');
insert into r select 'BOOK4 the database refuses simulated payment for a real (non-demo) club (decision D1)',
  exists (select 1 from pg_constraint where conrelid = 'clubs'::regclass and pg_get_constraintdef(oid) ~ 'is_demo'), '$D1', '';

-- Daylight saving: Beirut clocks go back at midnight on Sat 30 Oct 2027 (UTC+3 -> UTC+2), so the hour
-- 23:00-24:00 happens twice. A club open all night should offer every real half hour.
update clubs set booking_window_days = 365, open_time = '00:00', close_time = '24:00' where slug = 'batroun';
insert into r select 'BOOK5 a club open past midnight offers every real half hour on the night the clocks go back (finding T1)',
  count(distinct start_at) = 6, 'known:T1', count(distinct start_at)::text || ' of 6 half hours offered from 22:00 local (19:00Z) to midnight (22:00Z)'
  from club_day_slots('2027-10-30', 'padel') where court_name = 'Padel 2' and start_at >= '2027-10-30 19:00Z' and start_at < '2027-10-30 22:00Z';
select id || '|' || coalesce(pass::text, 'f') || '|' || exp || '|' || coalesce(detail, '') from r order by id;
rollback;
SQL
} | $PSQL -d $DB -X -q -At 2>&1)
echo "== 1-2. catalog and role checks (one rolled-back transaction on $DB)"
echo "$out" | grep -E "^(ERROR|psql)" && fails=$((fails+1))
while IFS='|' read -r id pass exp detail; do
  [ -z "$id" ] && continue
  case "$pass" in t|true) p=t;; *) p=f;; esac
  report "$id" "$p" "$exp" "$detail"
done < <(echo "$out" | grep -E "^(CAT|PRIV|BOOK)")

# ---------------------------------------------------------------- 3: races in a scratch copy
echo "== 3. races (two real sessions, scratch copy $RACE)"
$PSQL -q -d postgres -c "drop database if exists $RACE" -c "create database $RACE template $DB" >/dev/null 2>&1 || { echo "FAIL cannot create $RACE"; exit 1; }
trap '$PSQL -q -d postgres -c "drop database if exists $RACE" >/dev/null 2>&1' EXIT
# CONTROL=1: remove the court exclusion constraint in the scratch copy only. RACE1, RACE2 and INV1
# must then FAIL — proof that the races are real and the checks can see a double booking.
if [ -n "${CONTROL:-}" ]; then
  $PSQL -q -d $RACE -c "alter table bookings drop constraint no_double_booking_court;" >/dev/null && echo "   CONTROL: exclusion constraint removed in $RACE"
fi
q() { $PSQL -X -q -At -d $RACE "$@" 2>&1; }
as() { printf "set role authenticated;\nselect set_config('request.jwt.claim.sub', '%s', false) \\\\g /dev/null\n%s\n" "$1" "$2"; }
q -c "insert into auth.users (id, email) values ('$P1','p1@r.test'),('$P2','p2@r.test'),('$SA','sa@r.test'),('a0000000-0000-4000-8000-0000000000ad','ad@r.test');
      update profiles set roles = '{player,admin}' where id = 'a0000000-0000-4000-8000-0000000000ad';
      insert into club_staff (club_id, profile_id) select id, '$SA' from clubs where slug = 'batroun';" >/dev/null
CLUBQ="(select id from clubs where slug = 'batroun')"; K() { echo "(select id from courts where name = '$1')"; }
active_at() { q -c "select count(*) from bookings where court_id = $(K "$1") and status in ('pending','confirmed') and tstzrange(start_at, end_at) && tstzrange($2, $3)"; }
errof() { grep -oE "ERROR: +[a-z_]+|ERROR: +conflicting key|ERROR: +deadlock[a-z ]*" "$1" | head -1 | sed 's/ERROR: *//'; }

# R1: a desk walk-in and a player's hold for the same slot at the same moment
as "$P1" "begin; select booking_id from hold_slot($CLUBQ, $(K 'Padel 1'), $(AT 6 18:00), $(AT 6 19:30), gen_random_uuid()); select pg_sleep(1.5); commit;" | q > /tmp/aud_r1a.log &
sleep 0.5
as "$SA" "select staff_book($CLUBQ, $(K 'Padel 1'), $(AT 6 18:00), $(AT 6 19:30), 'Walk-in', null);" | q > /tmp/aud_r1b.log
wait
n=$(active_at 'Padel 1' "$(AT 6 18:00)" "$(AT 6 19:30)"); e=$(errof /tmp/aud_r1b.log)
report "RACE1 desk walk-in vs player hold, same slot: one booking, the other told slot_taken" $([ "$n" = 1 ] && [ "$e" = slot_taken ] && echo t || echo f) pass "active=$n second=$e"

# R2: a staff move and a player's hold into the same target slot
WB=$(as "$SA" "select staff_book($CLUBQ, $(K 'Padel 2'), $(AT 7 10:00), $(AT 7 11:30), 'To move', null);" | q | grep -E '^[0-9a-f-]{36}$')
as "$P2" "begin; select booking_id from hold_slot($CLUBQ, $(K 'Padel 3'), $(AT 7 18:00), $(AT 7 19:30), gen_random_uuid()); select pg_sleep(1.5); commit;" | q > /tmp/aud_r2a.log &
sleep 0.5
as "$SA" "select move_booking('$WB', $(K 'Padel 3'), $(AT 7 18:00), $(AT 7 19:30));" | q > /tmp/aud_r2b.log
wait
n=$(active_at 'Padel 3' "$(AT 7 18:00)" "$(AT 7 19:30)"); e=$(errof /tmp/aud_r2b.log)
still=$(q -c "select court_id = $(K 'Padel 2') and status = 'confirmed' from bookings where id = '$WB'")
report "RACE2 staff move vs player hold into one slot: one booking; the moved booking stays where it was" $([ "$n" = 1 ] && [ "$e" = slot_taken ] && [ "$still" = t ] && echo t || echo f) pass "active=$n move=$e unchanged=$still"

# R3: a player cancels while staff move the same booking
CB=$(as "$SA" "select staff_book($CLUBQ, $(K 'Padel 2'), $(AT 8 10:00), $(AT 8 11:00), 'Both', null);" | q | grep -E '^[0-9a-f-]{36}$')
as "$SA" "begin; select move_booking('$CB', $(K 'Padel 3'), $(AT 8 12:00), $(AT 8 13:00)); select pg_sleep(1.5); commit;" | q > /tmp/aud_r3a.log &
sleep 0.5
as "$SA" "select cancel_booking('$CB', true);" | q > /tmp/aud_r3b.log
wait
st=$(q -c "select status || '@' || (select name from courts where id = court_id) || ' ' || to_char(start_at at time zone 'Asia/Beirut', 'HH24:MI') from bookings where id = '$CB'")
e1=$(errof /tmp/aud_r3a.log); e2=$(errof /tmp/aud_r3b.log)
report "RACE3 move and cancel of one booking at once: both apply in order, no error, ends cancelled at the new time" $([ "$st" = "cancelled@Padel 3 12:00" ] && [ -z "$e1$e2" ] && echo t || echo f) pass "final=$st errors=$e1/$e2"

echo "== 4a. booking/payment invariants after races 1-3 (holds still live)"
invariants() { # label
  while IFS='|' read -r rule n ex; do
    [ -z "$rule" ] && continue
    report "$rule ($1)" $([ "$n" = 0 ] && echo t || echo f) pass "$n violation(s) e.g. $ex"
  done < <($PSQL -X -At -F '|' -d $RACE -f supabase/tests/audit/invariants.sql 2>&1)
}
invariants "after R1-R3"

# R4: one player, two desk bookings at once, one place left under the club's cap
as "a0000000-0000-4000-8000-0000000000ad" "select set_club_payment_mode($CLUBQ, 'at_desk');" | q >/dev/null
q -c "update clubs set max_upcoming_bookings = 3 where slug = 'batroun';" >/dev/null
for d in 9 10; do as "$P1" "select booking_id from book_at_desk($(K 'Padel 1'), $(AT $d 10:00), $(AT $d 11:00), gen_random_uuid());" | q >/dev/null; done
as "$P1" "begin; select booking_id from book_at_desk($(K 'Padel 2'), $(AT 11 10:00), $(AT 11 11:00), gen_random_uuid()); select pg_sleep(1.5); commit;" | q > /tmp/aud_r4a.log &
sleep 0.5
as "$P1" "select booking_id from book_at_desk($(K 'Padel 3'), $(AT 12 10:00), $(AT 12 11:00), gen_random_uuid());" | q > /tmp/aud_r4b.log
wait
n=$(q -c "select count(*) from bookings where player_id = '$P1' and status = 'confirmed' and start_at > now()"); e=$(errof /tmp/aud_r4b.log)
report "RACE4 one player, two desk bookings at once with one place left: cap holds, the second told too_many_upcoming" $([ "$n" = 3 ] && [ "$e" = too_many_upcoming ] && echo t || echo f) pass "upcoming=$n second=$e"

# ---------------------------------------------------------------- 4: invariants after the races
echo "== 4b. invariants after all races (incl. the switch to pay-at-the-desk, which expires holds)"
invariants "after R4"
$PSQL -q -d postgres -c "drop database if exists $RACE" >/dev/null 2>&1
echo
echo "summary: $oks ok, $known known findings, $fails FAIL, $xpass XPASS"
[ $fails = 0 ] && [ $xpass = 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"
[ $fails = 0 ] && [ $xpass = 0 ]
