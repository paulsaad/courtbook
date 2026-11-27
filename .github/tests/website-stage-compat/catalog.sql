-- one JSON document describing what the website can see/do at this migration stage (read only)
with rels as (
  select c.oid, c.relname, c.relkind, c.relrowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r','v','m','p')
), roles(r) as (values ('anon'),('authenticated'),('service_role'))
select json_build_object(
 'relations', (select json_object_agg(relname, json_build_object(
     'kind', relkind, 'rls', relrowsecurity,
     'columns', (select json_agg(a.attname order by a.attnum) from pg_attribute a where a.attrelid = rels.oid and a.attnum > 0 and not a.attisdropped),
     'table_priv', (select json_object_agg(r, json_build_object(
         'select', has_table_privilege(r, rels.oid, 'SELECT'), 'insert', has_table_privilege(r, rels.oid, 'INSERT'),
         'update', has_table_privilege(r, rels.oid, 'UPDATE'), 'delete', has_table_privilege(r, rels.oid, 'DELETE'))) from roles),
     'col_priv', (select json_object_agg(r, (select json_object_agg(a.attname, json_build_object(
         'select', has_column_privilege(r, rels.oid, a.attnum, 'SELECT'), 'insert', has_column_privilege(r, rels.oid, a.attnum, 'INSERT'),
         'update', has_column_privilege(r, rels.oid, a.attnum, 'UPDATE')))
         from pg_attribute a where a.attrelid = rels.oid and a.attnum > 0 and not a.attisdropped)) from roles),
     'policies', (select coalesce(json_agg(json_build_object('cmd', p.polcmd, 'roles',
         (select coalesce(json_agg(case when x = 0 then 'public' else (select rolname from pg_roles where oid = x) end), '[]') from unnest(p.polroles) x),
         'permissive', p.polpermissive, 'name', p.polname,
         'using', pg_get_expr(p.polqual, p.polrelid), 'check', pg_get_expr(p.polwithcheck, p.polrelid)) order by p.polname), '[]')
       from pg_policy p where p.polrelid = rels.oid),
     'fks', (select coalesce(json_agg(json_build_object('cols', (select json_agg(attname) from pg_attribute where attrelid = co.conrelid and attnum = any(co.conkey)),
         'ref', (select relname from pg_class where oid = co.confrelid))), '[]') from pg_constraint co where co.conrelid = rels.oid and co.contype = 'f')
   )) from rels),
 'functions', (select json_object_agg(proname, sigs) from (
   select p.proname, json_agg(json_build_object(
     'args', (select coalesce(json_agg(nm), '[]') from unnest(coalesce(p.proargnames, '{}'::text[]), coalesce(p.proargmodes, array_fill('i'::"char", array[coalesce(array_length(p.proargnames,1),0)]))) as t(nm, md) where md in ('i','b','v')),
     'nargs', p.pronargs, 'ndefaults', p.pronargdefaults,
     'exec', (select json_object_agg(r, has_function_privilege(r, p.oid, 'EXECUTE')) from roles))) sigs
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' group by p.proname) f)
);
