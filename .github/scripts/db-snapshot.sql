-- Database snapshot for backup verification — READ ONLY. Prints table names and NUMBERS only
-- (row counts, object counts, code fingerprints): never row contents, names, emails or phones.
-- Run against the source database and against the restored copy; the two outputs must match.
\set QUIET on
set default_transaction_read_only = on;
\pset tuples_only on
\pset format unaligned
\pset fieldsep '|'
with rows as (
  select 'rows ' || schemaname || '.' || tablename as k,
         (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', schemaname, tablename), false, true, '')))[1]::text as v
  from pg_tables where schemaname in ('public', 'auth', 'storage')
), objects as (
  select 'objects public tables' as k, count(*)::text as v from pg_tables where schemaname = 'public'
  union all select 'objects public functions', count(*)::text from pg_proc where pronamespace = 'public'::regnamespace
  union all select 'objects public policies', count(*)::text from pg_policies where schemaname = 'public'
  union all select 'objects public triggers', count(*)::text from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relnamespace = 'public'::regnamespace and not t.tgisinternal
  union all select 'objects public constraints', count(*)::text from pg_constraint where connamespace = 'public'::regnamespace
  union all select 'fingerprint public function code', md5(string_agg(proname || ':' || md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g')), ',' order by proname, md5(prosrc))) from pg_proc where pronamespace = 'public'::regnamespace
  union all select 'fingerprint public columns', md5(string_agg(table_name || '.' || column_name || ':' || data_type, ',' order by table_name, column_name)) from information_schema.columns where table_schema = 'public'
  union all select 'fingerprint public policies', md5(string_agg(tablename || '.' || policyname || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), ',' order by tablename, policyname)) from pg_policies where schemaname = 'public'
)
select k, v from (select * from rows union all select * from objects) x order by k;
