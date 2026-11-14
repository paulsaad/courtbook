-- Summary of schema_fingerprint.sql: one row per kind of object, with a count and one hash.
-- Read only; safe to run in the Supabase SQL editor. Two databases built from the same migrations
-- give the same rows. Prints one line per schema object in public (functions, policies, columns, grants, constraints,
-- triggers), each with a short hash of its definition, so two databases built from the same
-- migrations can be compared line by line. Read only.
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
)
select split_part(item, ' ', 1) || case when item like 'grant %' then ' ' || split_part(item, ' ', 2) else '' end as kind,
       count(*) as objects,
       left(md5(string_agg(item || ' ' || left(h, 10), E'\n' order by item)), 12) as hash
from items group by 1 order by 1;
