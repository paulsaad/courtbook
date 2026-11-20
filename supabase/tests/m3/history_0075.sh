#!/usr/bin/env bash
# 0075 (admin_blocks_received) on the local replica after run.sh: one rolled-back transaction.
#   PSQL="sudo -u postgres psql" bash supabase/tests/m3/history_0075.sh
PSQL=${PSQL:-psql}; DB=courtbook_test
out=$($PSQL -X -q -At -d $DB -v ON_ERROR_STOP=1 <<'SQL'
begin;
\i supabase/migrations/0075_report_history.sql
create function pg_temp.r(who uuid, q text) returns text language plpgsql as $f$
declare res text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(who::text, ''), true);
  execute 'set local role authenticated';
  begin execute q into res; exception when others then res := 'ERR ' || sqlerrm; end;
  execute 'reset role';
  return coalesce(res, 'null');
end $f$;
insert into auth.users (id, email) select ('e7500000-0000-4000-8000-00000000000' || i)::uuid, 'h' || i || '@0075.test' from generate_series(1, 4) i;
update profiles set roles = '{player,admin}' where id = 'e7500000-0000-4000-8000-000000000004';
insert into player_blocks values ('e7500000-0000-4000-8000-000000000001', 'e7500000-0000-4000-8000-000000000003'),
                                 ('e7500000-0000-4000-8000-000000000002', 'e7500000-0000-4000-8000-000000000003');
select 'H1 admin sees blocks received|' || pg_temp.r('e7500000-0000-4000-8000-000000000004',
  $q$select string_agg(right(profile_id::text, 1) || ':' || blocks_received, ',' order by profile_id) from admin_blocks_received(array['e7500000-0000-4000-8000-000000000003', 'e7500000-0000-4000-8000-000000000001']::uuid[])$q$);
select 'H2 a player is refused|' || pg_temp.r('e7500000-0000-4000-8000-000000000001', $q$select count(*)::text from admin_blocks_received(array['e7500000-0000-4000-8000-000000000003']::uuid[])$q$);
select 'H3 anonymous cannot call it|' || (not has_function_privilege('anon', 'admin_blocks_received(uuid[])', 'execute'))::text;
select 'H4 empty or null list: nothing|' || pg_temp.r('e7500000-0000-4000-8000-000000000004', 'select count(*)::text from admin_blocks_received(null)');
rollback;
SQL
)
fails=0
check() { line=$(echo "$out" | grep "^$1"); val=${line#*|}; if [ "$val" = "$2" ]; then echo "ok    $1"; else echo "FAIL  $1  [$val]"; fails=$((fails+1)); fi; }
check "H1 admin sees blocks received" "1:0,3:2"
check "H2 a player is refused" "ERR forbidden"
check "H3 anonymous cannot call it" "true"
check "H4 empty or null list: nothing" "0"
[ $fails = 0 ] && echo "RESULT: PASS" || { echo "RESULT: FAIL"; exit 1; }
