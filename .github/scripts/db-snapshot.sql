-- Database snapshot for backup verification — READ ONLY. Prints names of tables and objects and
-- NUMBERS or one-way hashes only: never row contents, names, emails or phones.
-- Run against the source database and against the restored copy; the outputs must match.
--   rows     every table's row count (public, auth, storage)
--   data     a hash of each public table's full contents, and of the account columns in auth.users /
--            auth.identities and the storage records (columns that exist on every platform version)
--   security row-level security per table, policies (public and storage), table and function grants to
--            anon / authenticated / service_role, function code, SECURITY DEFINER and search_path,
--            triggers
--   schema   constraints, columns
--   other    sequence positions, server major version
\set QUIET on
set default_transaction_read_only = on;
\pset tuples_only on
\pset format unaligned
\pset fieldsep '|'
with
q(k, sql) as (
  select 'rows ' || schemaname || '.' || tablename, format('select count(*) from %I.%I', schemaname, tablename)
  from pg_tables where schemaname in ('public', 'auth', 'storage')
  union all
  select 'data public.' || tablename, format('select md5(coalesce(string_agg(t::text, %L order by t::text), %L)) from public.%I t', chr(10), '', tablename)
  from pg_tables where schemaname = 'public'
  union all select 'data auth.users (account columns)', $s$select md5(coalesce(string_agg(concat_ws('|', id, email, phone, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at), chr(10) order by id), '')) from auth.users$s$
  union all select 'data auth.identities (account columns)', $s$select md5(coalesce(string_agg(concat_ws('|', id, user_id, provider, provider_id, identity_data), chr(10) order by id), '')) from auth.identities$s$
  union all select 'data storage.buckets', $s$select md5(coalesce(string_agg(concat_ws('|', id, name, public, file_size_limit, allowed_mime_types), chr(10) order by id), '')) from storage.buckets$s$
  union all select 'data storage.objects (records)', $s$select md5(coalesce(string_agg(concat_ws('|', id, bucket_id, name, metadata), chr(10) order by id), '')) from storage.objects$s$
),
measured as (
  select k, (xpath('/row/v/text()', query_to_xml('select (' || sql || ')::text as v', false, true, '')))[1]::text as v from q
),
objects(k, v) as (
  select 'objects public tables', count(*)::text from pg_tables where schemaname = 'public'
  union all select 'objects public functions', count(*)::text from pg_proc where pronamespace = 'public'::regnamespace
  union all select 'objects public constraints', count(*)::text from pg_constraint where connamespace = 'public'::regnamespace
  union all select 'security row-level security (public tables)', md5(string_agg(relname || ':' || relrowsecurity || ':' || relforcerowsecurity, ',' order by relname)) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'
  union all select 'security policies (public, storage)', md5(string_agg(schemaname || '.' || tablename || '.' || policyname || ':' || permissive || ':' || array_to_string(roles, '+') || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), ',' order by schemaname, tablename, policyname)) from pg_policies where schemaname in ('public', 'storage')
  union all select 'security table grants (anon, authenticated, service_role)', md5(string_agg(table_name || ':' || grantee || ':' || privilege_type, ',' order by table_name, grantee, privilege_type)) from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role')
  union all select 'security function grants (anon, authenticated, service_role)', md5(string_agg(p.oid::regprocedure::text || ':' || has_function_privilege('anon', p.oid, 'execute') || has_function_privilege('authenticated', p.oid, 'execute') || has_function_privilege('service_role', p.oid, 'execute'), ',' order by p.oid::regprocedure::text)) from pg_proc p where p.pronamespace = 'public'::regnamespace
  union all select 'security function code, definer, search_path', md5(string_agg(p.oid::regprocedure::text || ':' || md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g')) || ':' || prosecdef || ':' || coalesce(array_to_string(proconfig, ';'), ''), ',' order by p.oid::regprocedure::text)) from pg_proc p where p.pronamespace = 'public'::regnamespace
  union all select 'security triggers (public)', md5(string_agg(c.relname || '.' || t.tgname || ':' || t.tgenabled::text, ',' order by c.relname, t.tgname)) from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relnamespace = 'public'::regnamespace and not t.tgisinternal
  union all select 'schema constraints (public)', md5(string_agg(conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid), ',' order by conrelid::regclass::text, conname)) from pg_constraint where connamespace = 'public'::regnamespace
  union all select 'schema columns (public)', md5(string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), ',' order by table_name, column_name)) from information_schema.columns where table_schema = 'public'
  union all select 'other sequences (public)', coalesce(md5(string_agg(sequencename || ':' || coalesce(last_value, 0), ',' order by sequencename)), 'none') from pg_sequences where schemaname = 'public'
  union all select 'other server major version', (current_setting('server_version_num')::int / 10000)::text
)
select k, v from (select * from measured union all select * from objects) x order by k;
