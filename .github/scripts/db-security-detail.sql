-- Security details for backup verification — READ ONLY. Object names, roles and privileges only.
\set QUIET on
set default_transaction_read_only = on;
\pset tuples_only on
\pset format unaligned
select 'tablegrant ' || table_name || ' ' || grantee || ' ' || privilege_type from information_schema.role_table_grants
  where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role')
union all
select 'columngrant ' || table_name || '.' || column_name || ' ' || grantee || ' ' || privilege_type from information_schema.column_privileges
  where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role')
    and (table_name, grantee, privilege_type) not in (select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public')
union all
select 'funcgrant ' || p.oid::regprocedure::text || ' ' || r from pg_proc p, unnest(array['anon', 'authenticated', 'service_role']) r
  where p.pronamespace = 'public'::regnamespace and has_function_privilege(r, p.oid, 'execute')
union all
select 'policy ' || schemaname || '.' || tablename || '.' || policyname || ' ' || cmd || ' ' || array_to_string(roles, '+') from pg_policies
  where schemaname in ('public', 'storage')
order by 1;
