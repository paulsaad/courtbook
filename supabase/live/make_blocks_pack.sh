#!/usr/bin/env bash
# Generates the deployment files for migrations 0076 and 0077 (calendar blocks) in supabase/live/:
#   0076_preflight.sql 0076_apply.sql 0076_postcheck.sql 0076_rollback.sql
#   0077_preflight.sql 0077_apply.sql 0077_postcheck.sql 0077_rollback.sql
# Expected function versions are hashes of the bodies (trailing spaces and Windows line endings
# ignored), taken from local builds of origin/main + 0076 (+ 0077) and checked by
# supabase/tests/live_blocks.sh, which also checks these files are in sync with this script.
#   bash supabase/live/make_blocks_pack.sh      (OUT=<dir> writes elsewhere, for the sync check)
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=${OUT:-supabase/live}

H="md5(regexp_replace(prosrc, '[ \\t\\r]+(\\n|\$)', '\\1', 'g'))"
fn() { echo "(select count(*) = 1 and max($H) = '$2' from pg_proc where pronamespace = 'public'::regnamespace and proname = '$1')"; }
seen() { echo "coalesce((select string_agg($H, ',') from pg_proc where pronamespace = 'public'::regnamespace and proname = '$1'), 'missing')"; }
absent() { echo "not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = '$1')"; }
# the functions 0076/0077 rely on and leave unchanged (0001–0075 versions)
KEEP="reject_block_over_booking=18c335039c80db474319e30ddbde01ec reject_booking_over_block=1c955f6aaf4eed5d27a8be8032ca149f expire_stale_holds=bd5333a933065bffc0599dcee74b389d assert_valid_court_slot=842d14da33899a48cb53eb356bdf671c close_club=5374dc2a493362cdc644fb0c65256f42 is_staff_of=2fd33ea362331532c1508cdb70777296"
NEW76="staff_block=1e8dc62bedc9d9bbadcfd68cd906b71d assert_valid_block=443366cc1f3829e0bc3991c238b5c90c blocks_direct_write_rules=58ae4fef2de6a7daaca5d9a48b639525"
NEW77="blocks_direct_insert_refused=92795897f08203a5161d9ae162bd7f3a"
rows() { local part=$1 label=$2; shift 2; for kv in "$@"; do k=${kv%%=*}; v=${kv#*=}; echo "  union all select $part, '$k: $label', $(fn $k $v), $(seen $k)"; done; }
all_ok() { local s=""; for kv in "$@"; do k=${kv%%=*}; v=${kv#*=}; s="$s and $(fn $k $v)"; done; echo "true$s"; }

FPRINT="(select count(*) || ' blocks, ' || coalesce(md5(string_agg(id::text || '|' || club_id || '|' || court_id || '|' || start_at || '|' || end_at || '|' || coalesce(reason, '') || '|' || created_by || '|' || created_at, ',' order by id)), '-') from public.blocks)"
POLICIES="(select coalesce(string_agg(policyname || ' (' || cmd || ')', ', ' order by policyname), 'none') from pg_policies where schemaname = 'public' and tablename = 'blocks')"
TRIGGERS="(select coalesce(string_agg(tgname, ', ' order by tgname), 'none') from pg_trigger where tgrelid = 'public.blocks'::regclass and not tgisinternal)"
CORE="exists (select 1 from pg_trigger where tgrelid = 'public.blocks'::regclass and tgname = 'blocks_booking_check' and tgenabled = 'O') and exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid where t.tgrelid = 'public.bookings'::regclass and p.proname = 'reject_booking_over_block' and t.tgenabled = 'O') and exists (select 1 from pg_constraint where conrelid = 'public.blocks'::regclass and conname = 'no_overlapping_blocks' and contype = 'x')"
OWNERS="current_user not in ('anon', 'authenticated') and (select prosecdef and pg_get_userbyid(proowner) not in ('anon', 'authenticated') from pg_proc where pronamespace = 'public'::regnamespace and proname = 'close_club')"
P75="$POLICIES = 'blocks: staff read (SELECT), blocks: staff write (ALL)'"
P77="$POLICIES = 'blocks: staff delete (DELETE), blocks: staff read (SELECT)'"
G76="coalesce(has_function_privilege('authenticated', to_regprocedure('public.staff_block(uuid,uuid,timestamptz,timestamptz,text)'), 'execute') and not has_function_privilege('anon', to_regprocedure('public.staff_block(uuid,uuid,timestamptz,timestamptz,text)'), 'execute') and (select prosecdef and proconfig = '{search_path=public}' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'staff_block') and not has_function_privilege('anon', to_regprocedure('public.assert_valid_block(uuid,uuid,timestamptz,timestamptz)'), 'execute'), false)"
T76="exists (select 1 from pg_trigger where tgrelid = 'public.blocks'::regclass and tgname = 'blocks_direct_write_rules' and tgenabled = 'O')"
R77="not has_table_privilege('authenticated', 'public.blocks', 'UPDATE') and has_table_privilege('authenticated', 'public.blocks', 'INSERT') and has_table_privilege('authenticated', 'public.blocks', 'DELETE') and has_table_privilege('authenticated', 'public.blocks', 'SELECT')"
R76="has_table_privilege('authenticated', 'public.blocks', 'INSERT') and has_table_privilege('authenticated', 'public.blocks', 'UPDATE') and has_table_privilege('authenticated', 'public.blocks', 'DELETE') and has_table_privilege('authenticated', 'public.blocks', 'SELECT')"
T77="exists (select 1 from pg_trigger where tgrelid = 'public.blocks'::regclass and tgname = 'blocks_direct_insert_refused' and tgenabled = 'O') and not exists (select 1 from pg_trigger where tgrelid = 'public.blocks'::regclass and tgname = 'blocks_direct_write_rules')"
OUTSIDE="(select count(*)::text from public.blocks b join public.clubs c on c.id = b.club_id where b.end_at > now() and (extract(epoch from (b.end_at - b.start_at)) % (c.slot_minutes * 60) <> 0 or (b.start_at at time zone c.timezone)::time < c.open_time or (extract(epoch from ((b.end_at at time zone c.timezone) - date_trunc('day', b.start_at at time zone c.timezone))) / 60) > extract(epoch from c.close_time) / 60 or (extract(epoch from ((b.start_at at time zone c.timezone)::time - c.open_time)) / 60)::int % c.slot_minutes <> 0))"

header() { echo "-- $1 — $2. Generated by supabase/live/make_blocks_pack.sh — do not edit by hand."; }

# ---------------------------------------------------------------- 0076
{
  header 0076 "PREFLIGHT. READ ONLY: one SELECT, changes nothing"
  echo "-- Run on the target (staging first; live only after its own approval) immediately before 0076."
  echo "-- Part 1: every row must be ok = true, or 0076 is not applied. Part 2: information only."
  echo "with checks(part, item, ok, detail) as ("
  echo "  select 1, '0075 is applied (admin_blocks_received exists)', to_regproc('public.admin_blocks_received') is not null, ''"
  echo "  union all select 1, 'none of 0076 exists yet (staff_block, assert_valid_block, blocks_direct_write_rules)', $(absent staff_block) and $(absent assert_valid_block) and $(absent blocks_direct_write_rules), ''"
  rows 1 "the 0001–0075 version (unchanged by 0076)" $KEEP
  echo "  union all select 1, 'overlap protection in place: block and booking triggers enabled, no_overlapping_blocks', $CORE, ''"
  echo "  union all select 1, 'blocks policies are the 0075 ones', $P75, $POLICIES"
  echo "  union all select 1, 'blocks triggers are the 0075 ones', $TRIGGERS = 'blocks_booking_check', $TRIGGERS"
  echo "  union all select 1, 'runs as the owner role; close_club has owner rights (the direct-write rule tells them apart)', $OWNERS, current_user::text"
  echo "  union all select 2, 'saved blocks (compare with the postcheck: 0076 changes none)', true, $FPRINT"
  echo "  union all select 2, 'saved future blocks the new rules would refuse (kept as they are)', true, $OUTSIDE"
  echo "  union all select 1, 'signed-in users can insert, update, delete and read blocks (the old website path)', $R76, ''"
  echo ")"
  echo "select part, item, ok, detail from checks order by part, item;"
} > "$OUT/0076_preflight.sql"

{
  header 0076 "POSTCHECK. READ ONLY: one SELECT, changes nothing"
  echo "-- Run right after 0076. Every row must be ok = true."
  echo "with checks(item, ok, detail) as ("
  echo "  select 'blocks policies unchanged (the current website still inserts directly)', $P75, $POLICIES"
  rows 0 "new in 0076" $NEW76 | sed 's/union all select 0, /union all select /'
  rows 0 "unchanged" $KEEP | sed 's/union all select 0, /union all select /'
  echo "  union all select 'staff_block: owner rights, fixed search path, signed-in users only', $G76, ''"
  echo "  union all select 'direct-write rule: trigger blocks_direct_write_rules enabled', $T76, $TRIGGERS"
  echo "  union all select 'overlap protection in place', $CORE, ''"
  echo "  union all select 'saved blocks: same as in the preflight (information)', true, $FPRINT"
  echo ")"
  echo "select item, ok, detail from checks order by item;"
} > "$OUT/0076_postcheck.sql"

{
  header "0076 for LIVE" "all or nothing"
  echo "-- Run once in Supabase → SQL Editor: 0076_preflight.sql (part 1 all ok), then this, then 0076_postcheck.sql."
  echo "-- Stops unless the database is the verified 0075 state; rolls back unless the result is the verified 0076"
  echo "-- and every saved block is exactly as before. A second run stops."
  echo "begin;"
  echo "set local lock_timeout = '5s';"
  echo "set local statement_timeout = '60s';"
  echo "do \$pre\$ begin"
  echo "  if not ($(all_ok $KEEP) and $CORE and $P75 and $OWNERS and $(absent staff_block) and $(absent assert_valid_block) and $(absent blocks_direct_write_rules)) then"
  echo "    raise exception 'STOPPED, nothing changed: not the verified 0075 starting point (0076 already applied?)';"
  echo "  end if;"
  echo "end \$pre\$;"
  echo "create temp table blocks_before on commit drop as select $FPRINT as fp;"
  echo "-- ===== migration 0076, unchanged from supabase/migrations/0076_staff_block.sql ====="
  cat supabase/migrations/0076_staff_block.sql
  echo "-- ===== end of migration 0076 ====="
  echo "do \$post\$ begin"
  echo "  if not ($(all_ok $KEEP $NEW76) and $G76 and $T76 and $CORE and $P75) then"
  echo "    raise exception 'ROLLED BACK: the result of 0076 is not the verified version';"
  echo "  end if;"
  echo "  if (select fp from blocks_before) is distinct from $FPRINT then"
  echo "    raise exception 'ROLLED BACK: saved blocks changed';"
  echo "  end if;"
  echo "end \$post\$;"
  echo "notify pgrst, 'reload schema';"
  echo "commit;"
  echo "select '0076 applied' as result;"
} > "$OUT/0076_apply.sql"

{
  header 0076 "ROLLBACK, all or nothing"
  echo "-- Back to 0075. Removes no block. Roll back 0077 first if it is applied, and put the website back on direct"
  echo "-- inserts first (the new website calls staff_block)."
  echo "begin;"
  echo "set local lock_timeout = '5s';"
  echo "do \$pre\$ begin"
  echo "  if not ($(all_ok $NEW76) and $P75) then"
  echo "    raise exception 'STOPPED, nothing changed: this database does not have the verified 0076 (or 0077 is still applied)';"
  echo "  end if;"
  echo "end \$pre\$;"
  echo "create temp table blocks_before on commit drop as select $FPRINT as fp;"
  echo "drop trigger if exists blocks_direct_write_rules on blocks;"
  echo "drop function if exists blocks_direct_write_rules();"
  echo "drop function if exists staff_block(uuid, uuid, timestamptz, timestamptz, text);"
  echo "drop function if exists assert_valid_block(uuid, uuid, timestamptz, timestamptz);"
  echo "do \$post\$ begin"
  echo "  if (select fp from blocks_before) is distinct from $FPRINT then raise exception 'ROLLED BACK: saved blocks changed'; end if;"
  echo "end \$post\$;"
  echo "notify pgrst, 'reload schema';"
  echo "commit;"
  echo "select '0076 rolled back' as result;"
} > "$OUT/0076_rollback.sql"

# ---------------------------------------------------------------- 0077
{
  header 0077 "PREFLIGHT. READ ONLY: one SELECT, changes nothing"
  echo "-- Run immediately before 0077, and only once the website that calls staff_block is live for this database"
  echo "-- (staging: the m3-dev preview; live: production) and the desk has reloaded its pages."
  echo "-- Part 1: every row must be ok = true, or 0077 is not applied. Part 2: information only."
  echo "with checks(part, item, ok, detail) as ("
  echo "  select 1, 'signed-in users can still insert, update, delete and read blocks directly (what 0077 changes, and its rollback restores)', $R76, ''"
  rows 1 "the verified 0076 version" $NEW76
  rows 1 "unchanged" $KEEP
  echo "  union all select 1, 'staff_block: owner rights, fixed search path, signed-in users only', $G76, ''"
  echo "  union all select 1, 'blocks policies are still the 0075/0076 ones', $P75, $POLICIES"
  echo "  union all select 1, '0077 not applied yet (no blocks_direct_insert_refused)', $(absent blocks_direct_insert_refused), $TRIGGERS"
  echo "  union all select 1, 'overlap protection in place', $CORE, ''"
  echo "  union all select 2, 'saved blocks (compare with the postcheck: 0077 changes none)', true, $FPRINT"
  echo "  union all select 2, 'blocks created in the last 24 hours (the new website saves through staff_block)', true, (select count(*)::text from public.blocks where created_at > now() - interval '24 hours')"
  echo ")"
  echo "select part, item, ok, detail from checks order by part, item;"
} > "$OUT/0077_preflight.sql"

{
  header 0077 "POSTCHECK. READ ONLY: one SELECT, changes nothing"
  echo "-- Run right after 0077. Every row must be ok = true."
  echo "with checks(item, ok, detail) as ("
  echo "  select 'blocks policies: staff read and staff delete only (no direct insert or update)', $P77, $POLICIES"
  echo "  union all select 'rights of signed-in users: no update; insert kept only for the reload answer; delete and read kept', $R77, ''"
  echo "  union all select 'older pages get the reload answer: blocks_direct_insert_refused enabled, 0076 direct-write rule gone', $T77, $TRIGGERS"
  rows 0 "new in 0077" $NEW77 | sed 's/union all select 0, /union all select /'
  rows 0 "unchanged" $NEW76 $KEEP | sed 's/union all select 0, /union all select /'
  echo "  union all select 'staff_block: owner rights, fixed search path, signed-in users only', $G76, ''"
  echo "  union all select 'overlap protection in place', $CORE, ''"
  echo "  union all select 'saved blocks: same as in the preflight (information)', true, $FPRINT"
  echo ")"
  echo "select item, ok, detail from checks order by item;"
} > "$OUT/0077_postcheck.sql"

{
  header "0077 for LIVE" "all or nothing"
  echo "-- Run once in Supabase → SQL Editor, only after the production website calls staff_block:"
  echo "-- 0077_preflight.sql (part 1 all ok), then this, then 0077_postcheck.sql. A second run stops."
  echo "begin;"
  echo "set local lock_timeout = '5s';"
  echo "set local statement_timeout = '60s';"
  echo "do \$pre\$ begin"
  echo "  if not ($(all_ok $KEEP $NEW76) and $G76 and $P75 and $R76 and $CORE and $(absent blocks_direct_insert_refused)) then"
  echo "    raise exception 'STOPPED, nothing changed: not the verified 0076 state (0077 already applied, or 0076 missing?)';"
  echo "  end if;"
  echo "end \$pre\$;"
  echo "create temp table blocks_before on commit drop as select $FPRINT as fp;"
  echo "-- ===== migration 0077, unchanged from supabase/migrations/0077_blocks_through_functions.sql ====="
  cat supabase/migrations/0077_blocks_through_functions.sql
  echo "-- ===== end of migration 0077 ====="
  echo "do \$post\$ begin"
  echo "  if not ($(all_ok $KEEP $NEW76 $NEW77) and $G76 and $P77 and $R77 and $T77 and $CORE) then"
  echo "    raise exception 'ROLLED BACK: the result of 0077 is not the verified version';"
  echo "  end if;"
  echo "  if (select fp from blocks_before) is distinct from $FPRINT then"
  echo "    raise exception 'ROLLED BACK: saved blocks changed';"
  echo "  end if;"
  echo "end \$post\$;"
  echo "notify pgrst, 'reload schema';"
  echo "commit;"
  echo "select '0077 applied' as result;"
} > "$OUT/0077_apply.sql"

{
  header 0077 "ROLLBACK, all or nothing"
  echo "-- Back to 0076: staff may insert blocks directly again (with 0076's rules). Removes no block."
  echo "begin;"
  echo "set local lock_timeout = '5s';"
  echo "do \$pre\$ begin"
  echo "  if not ($(all_ok $NEW77) and $P77) then"
  echo "    raise exception 'STOPPED, nothing changed: this database does not have the verified 0077';"
  echo "  end if;"
  echo "end \$pre\$;"
  echo "create temp table blocks_before on commit drop as select $FPRINT as fp;"
  echo "drop trigger if exists blocks_direct_insert_refused on blocks;"
  echo "drop function if exists blocks_direct_insert_refused();"
  echo "drop policy if exists \"blocks: staff delete\" on blocks;"
  echo "drop policy if exists \"blocks: staff write\" on blocks;"
  echo "create policy \"blocks: staff write\" on blocks for all"
  echo "  using (is_staff_of(club_id)) with check (is_staff_of(club_id) and created_by = auth.uid());"
  echo "grant update on table blocks to authenticated;   -- the right 0077 took away (its preflight checked it was there)"
  echo "drop trigger if exists blocks_direct_write_rules on blocks;"
  echo "create trigger blocks_direct_write_rules"
  echo "  before insert or update of club_id, court_id, start_at, end_at on blocks"
  echo "  for each row execute function blocks_direct_write_rules();"
  echo "do \$post\$ begin"
  echo "  if (select fp from blocks_before) is distinct from $FPRINT then raise exception 'ROLLED BACK: saved blocks changed'; end if;"
  echo "end \$post\$;"
  echo "notify pgrst, 'reload schema';"
  echo "commit;"
  echo "select '0077 rolled back' as result;"
} > "$OUT/0077_rollback.sql"
echo "wrote 0076_{preflight,apply,postcheck,rollback}.sql and 0077_{preflight,apply,postcheck,rollback}.sql in $OUT"
