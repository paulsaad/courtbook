-- Writes (does not run) the SQL that puts back the source's exact permissions after a restore — READ ONLY.
-- Why: a new Supabase database grants new tables and functions to anon / authenticated / service_role
-- by default, and a dump does not take those default grants away again. This script, run last in the
-- restore, revokes everything those roles (and PUBLIC) hold on public objects and grants back exactly
-- what the source had — tables, views, sequences, columns, functions — then recreates the storage
-- policies as on the source. Output: SQL text only (object names, role names, policy expressions).
\set QUIET on
set default_transaction_read_only = on;
\pset tuples_only on
\pset format unaligned
with roles(oid, name) as (
  select 0::oid, 'public' union all select oid, quote_ident(rolname) from pg_roles where rolname in ('anon', 'authenticated', 'service_role')
),
rels as (
  select c.oid, c.relkind, c.relacl, case c.relkind when 'S' then 'sequence ' else 'table ' end || c.oid::regclass::text as obj
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
),
funcs as (
  select p.oid, p.proacl, 'function ' || p.oid::regprocedure::text as obj from pg_proc p where p.pronamespace = 'public'::regnamespace
),
stmts(o, line) as (
  select 1, 'revoke all on ' || obj || ' from public, anon, authenticated, service_role;' from rels
  union all
  select 2, format('grant %s on %s to %s%s;', a.privilege_type, r.obj, ro.name, case when a.is_grantable then ' with grant option' else '' end)
  from rels r, aclexplode(r.relacl) a join roles ro on ro.oid = a.grantee
  union all
  select 3, format('grant %s (%s) on %s to %s;', a.privilege_type, quote_ident(att.attname), r.obj, ro.name)
  from rels r join pg_attribute att on att.attrelid = r.oid and att.attacl is not null and not att.attisdropped,
       aclexplode(att.attacl) a join roles ro on ro.oid = a.grantee
  union all
  select 4, 'revoke all on ' || obj || ' from public, anon, authenticated, service_role;' from funcs
  union all
  select 5, format('grant %s on %s to %s;', a.privilege_type, f.obj, ro.name)
  from funcs f, aclexplode(coalesce(f.proacl, acldefault('f', (select proowner from pg_proc where oid = f.oid)))) a join roles ro on ro.oid = a.grantee
  union all
  select 6, format('drop policy if exists %I on %I.%I;', policyname, schemaname, tablename) from pg_policies where schemaname = 'storage'
  union all
  select 7, format('create policy %I on %I.%I as %s for %s to %s%s%s;', policyname, schemaname, tablename, permissive, cmd,
                   (select string_agg(case when r = 'public' then 'public' else quote_ident(r) end, ', ') from unnest(roles) r),
                   case when qual is not null then ' using (' || qual || ')' else '' end,
                   case when with_check is not null then ' with check (' || with_check || ')' else '' end)
  from pg_policies where schemaname = 'storage'
)
select line from stmts order by o, line;
