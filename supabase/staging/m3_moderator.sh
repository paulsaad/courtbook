#!/usr/bin/env bash
# The staging moderator (Admin → Reports). STAGING ONLY; logs are public, so no address is printed.
#
#   check          READ ONLY (one read-only transaction, rolled back): which accounts have the admin role;
#                  for each, whether is_admin() is true when acting as that account; and, once 0074 is on
#                  staging, that admin_reports answers for them and refuses a player ('forbidden').
#   grant <id8>    adds the admin role to ONE account (first 8 characters of its id, from m3_accounts),
#                  printing its roles before and after. Needs Paul's approval. Nothing else changes.
set -euo pipefail
: "${DB:?DB missing}"
q() { psql "$DB" -X -q -v ON_ERROR_STOP=1 -At -F ' | ' "$@"; }
q -c "do \$\$ begin if to_regclass('staging_meta.applied') is null then raise exception 'not the staging database (no staging marker)'; end if; end \$\$;"

case "${1:-}" in
check)
  # one read-only DO block (temp functions are not allowed read-only); results as NOTICE lines
  q <<'SQL'
begin read only;
do $c$
declare a record; res text; n int; n2 int; player uuid; has74 boolean := to_regproc('public.admin_reports') is not null;
begin
  select count(*) into n from profiles where 'admin' = any(roles);
  raise notice 'admins on staging: %', n;
  for a in select id, coalesce(name, '-') as name, array_to_string(roles, ',') as roles from profiles where 'admin' = any(roles) order by name loop
    perform set_config('request.jwt.claim.sub', a.id::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', a.id, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    execute 'select is_admin()::text' into res;
    if has74 then
      begin execute $q$select count(*) from admin_reports('open')$q$ into n; exception when others then n := null; end;
    end if;
    if to_regproc('public.admin_blocks_received') is not null then
      begin execute $q$select count(*) from admin_blocks_received(array(select id from profiles))$q$ into n2; exception when others then n2 := null; end;
    end if;
    execute 'reset role';
    raise notice '% | admin_blocks_received as them: %', left(a.id::text, 8),
      case when to_regproc('public.admin_blocks_received') is null then 'needs 0075' else coalesce(n2::text || ' accounts answered', 'refused') end;
    raise notice '% | % | roles % | is_admin() as them: % | %', left(a.id::text, 8), a.name, a.roles, res,
      case when has74 then 'admin_reports as them: ' || coalesce(n::text || ' open', 'refused') else 'Reports: needs 0074' end;
  end loop;
  select id into player from profiles where not ('admin' = any(roles)) limit 1;
  if has74 and player is not null then
    perform set_config('request.jwt.claim.sub', player::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', player, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    begin execute $q$select count(*) from admin_reports('open')$q$ into n; res := 'ANSWERED (wrong)';
    exception when others then res := 'refused: ' || sqlerrm; end;
    execute 'reset role';
    raise notice 'a player calling admin_reports: %', res;
    if to_regproc('public.admin_blocks_received') is not null then
      perform set_config('request.jwt.claim.sub', player::text, true);
      perform set_config('request.jwt.claims', json_build_object('sub', player, 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
      begin execute $q$select count(*) from admin_blocks_received(array(select id from profiles))$q$ into n; res := 'ANSWERED (wrong)';
      exception when others then res := 'refused: ' || sqlerrm; end;
      execute 'reset role';
      raise notice 'a player calling admin_blocks_received: %', res;
    end if;
  else
    raise notice 'a player calling admin_reports: %', case when has74 then 'no player account' else 'needs 0074' end;
  end if;
end $c$;
rollback;
SQL
  ;;
grant)
  id8="${2:-}"; [[ "$id8" =~ ^[0-9a-f]{8}$ ]] || { echo "give one account id (8 hex characters, from m3_accounts)"; exit 1; }
  [ "$(q -c "select count(*) from profiles where id::text like '$id8%'")" = 1 ] || { echo "no single account starts with $id8: nothing done"; exit 1; }
  q <<SQL
begin;
select 'before: ' || left(id::text, 8) || ' ' || coalesce(name, '-') || ' roles ' || array_to_string(roles, ',') from profiles where id::text like '$id8%';
update profiles set roles = array_append(roles, 'admin') where id::text like '$id8%' and not ('admin' = any(roles));
select 'after:  ' || left(id::text, 8) || ' ' || coalesce(name, '-') || ' roles ' || array_to_string(roles, ',') from profiles where id::text like '$id8%';
commit;
SQL
  ;;
*) echo "usage: m3_moderator.sh check | grant <id8>"; exit 1;;
esac
