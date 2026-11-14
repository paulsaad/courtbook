-- 0065 PREFLIGHT for the LIVE database. READ ONLY: one SELECT, changes nothing.
-- Run in Supabase → SQL Editor on the live project. Every row's "ok" must be true. If any is false,
-- stop: do not apply 0065. The expected values are those of a database built from migrations
-- 0001–0064, which is exactly what staging was when all 50 staging checks passed.
with items as (
  select 'function ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as item,
         md5(p.prosrc || '|' || p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ','), '') || '|' || pg_get_function_result(p.oid)) as h
  from pg_proc p where p.pronamespace = 'public'::regnamespace
    and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')  -- extension members (btree_gist lives in public locally, in extensions on Supabase)
  union all
  select 'policy ' || schemaname || '.' || tablename || ' "' || policyname || '"',
         md5(cmd || '|' || permissive || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''))
  from pg_policies where schemaname in ('public', 'storage') and (schemaname = 'public' or policyname like 'club-media%')
  union all
  select 'column ' || table_name || '.' || column_name,
         md5(data_type || '|' || udt_name || '|' || is_nullable || '|' || coalesce(column_default, ''))
  from information_schema.columns where table_schema = 'public'
  union all
  select 'grant function ' || r.routine_name || ' ' || g.grantee, md5(string_agg(distinct g.privilege_type, ',') )
  from information_schema.role_routine_grants g join information_schema.routines r on r.specific_name = g.specific_name and r.specific_schema = g.specific_schema
  where g.routine_schema = 'public' and g.grantee in ('anon', 'authenticated', 'service_role')
    and not exists (select 1 from pg_proc p join pg_depend d on d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
                    where p.pronamespace = 'public'::regnamespace and p.proname = r.routine_name)
  group by r.routine_name, g.grantee
  union all
  select 'grant table ' || table_name || ' ' || grantee, md5(string_agg(privilege_type, ',' order by privilege_type))
  from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role')
  group by table_name, grantee
  union all
  select 'constraint ' || conrelid::regclass::text || ' ' || conname, md5(pg_get_constraintdef(oid))
  from pg_constraint where connamespace = 'public'::regnamespace
  union all
  select 'trigger ' || tgrelid::regclass::text || ' ' || tgname, md5(pg_get_triggerdef(oid))
  from pg_trigger where not tgisinternal and tgrelid::regclass::text not like 'storage.%' and tgrelid::regclass::text not like 'auth.%' and tgrelid::regclass::text not like 'realtime.%'
  union all
  select 'rls ' || relname, relrowsecurity::text from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'
),
summary as (
  select split_part(item, ' ', 1) || case when item like 'grant %' then ' ' || split_part(item, ' ', 2) else '' end as kind,
         count(*)::text || ' ' || left(md5(string_agg(item || ' ' || left(h, 10), E'\n' order by item)), 12) as found
  from items group by 1
),
expected(kind, value) as (values
    ('column', '266 0aed4c3b57fe'),
    ('constraint', '145 8a1da6fc1b87'),
    ('function', '101 fdfce7ab62c4'),
    ('grant function', '187 7d0f9fb6f561'),
    ('grant table', '67 b2aeadfdfd08'),
    ('policy', '54 9962e3dc839e'),
    ('rls', '28 e2fe16ad794a'),
    ('trigger', '9 198b3302cea9')
),
hs as (select oid from pg_proc where proname = 'hold_slot' and pronamespace = 'public'::regnamespace),
checks(n, check_name, found, expected) as (
  select 0, 'server version (information)', current_setting('server_version'), current_setting('server_version')
  union all
  select 1, 'structure: ' || e.kind, coalesce(s.found, 'missing'), e.value from expected e left join summary s using (kind)
  union all
  select 2, 'hold_slot: how many', (select count(*)::text from hs), '1'
  union all
  select 3, 'hold_slot: arguments', (select string_agg(pg_get_function_identity_arguments(oid), ' | ') from hs),
         'p_club uuid, p_court uuid, p_start timestamp with time zone, p_end timestamp with time zone'
  union all
  select 4, 'hold_slot: body', (select string_agg(md5(prosrc), ' | ') from pg_proc where oid in (select oid from hs)), 'a91e9a74505c97e17c4f910fa10d1e15'
  union all
  select 5, 'hold_slot: security definer, search_path public', (select string_agg(prosecdef::text || ' ' || coalesce(array_to_string(proconfig, ','), ''), ' | ') from pg_proc where oid in (select oid from hs)), 'true search_path=public'
  union all
  select 6, 'hold_slot: who may call it',
         (select string_agg(r || '=' || has_function_privilege(r, h.oid, 'execute')::text, ' ' order by r)
            from hs h, unnest(array['anon', 'authenticated', 'service_role']) r),
         'anon=false authenticated=true service_role=true'
  union all
  select 7, 'hold_slot: nothing depends on it (views, other objects)', (select count(*)::text from pg_depend where refobjid in (select oid from hs) and deptype = 'n'), '0'
  union all
  select 8, 'bookings.client_token column', (select data_type from information_schema.columns where table_schema = 'public' and table_name = 'bookings' and column_name = 'client_token'), 'uuid'
  union all
  select 9, 'one token per player (unique index)', (select indexdef from pg_indexes where schemaname = 'public' and indexname = 'bookings_one_per_client_token'),
         'CREATE UNIQUE INDEX bookings_one_per_client_token ON public.bookings USING btree (player_id, client_token) WHERE (client_token IS NOT NULL)'
)
select n as "#", check_name as "check", found, expected, (found = expected) as ok from checks order by n, check_name;
