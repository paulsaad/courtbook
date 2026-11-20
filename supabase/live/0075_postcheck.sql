-- 0075 (moderator history: blocks received) — POSTCHECK. READ ONLY. Every row must be ok = true.
-- On staging: Staging database workflow, action m3_0075_postcheck.
with checks(item, ok, detail) as (
  select 'admin_blocks_received: exactly one, the 0075 version', (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = 'cab286a9d0ff32a9a39a31452a9ad639' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'admin_blocks_received'),
    coalesce((select string_agg(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g')), ',') from pg_proc where pronamespace = 'public'::regnamespace and proname = 'admin_blocks_received'), 'missing')
  union all select 'signed-in users may call it (it checks is_admin), anonymous may not', case when to_regprocedure('public.admin_blocks_received(uuid[])') is null then false else has_function_privilege('authenticated', 'admin_blocks_received(uuid[])', 'execute') and not has_function_privilege('anon', 'admin_blocks_received(uuid[])', 'execute') end, ''
)
select item, ok, detail from checks order by item;
