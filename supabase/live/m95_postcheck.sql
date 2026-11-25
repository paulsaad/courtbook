-- 0095 (deletion vs booking lock order) — POSTCHECK. READ ONLY: one SELECT, changes nothing. Every row must be ok.
with f as (
  select p.proname, p.prosrc, md5(p.prosrc) as src, p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') as cfg,
         has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as auth
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('hold_slot', 'book_at_desk')
), checks(item, ok, detail) as (
  select 'hold_slot is exactly 0095''s', (select src from f where proname = 'hold_slot') = 'a02ba5d9625e1d8fefa7a8a392e47edd',
    coalesce((select src from f where proname = 'hold_slot'), 'missing')
  union all select 'book_at_desk is exactly 0095''s', (select src from f where proname = 'book_at_desk') = '63336c860bc89b9849660eceef8daca9',
    coalesce((select src from f where proname = 'book_at_desk'), 'missing')
  union all select 'both refuse a closing account before their first court lock',
    coalesce((select bool_and(position('if deletion_requested(v_player) then raise exception ''account_closed''; end if;' in prosrc) between 1 and position('perform lock_courts(' in prosrc)) from f), false), ''
  union all select 'both still run as their owner with search_path=public; signed-in may call them, visitors may not',
    (select bool_and(prosecdef and cfg = 'search_path=public' and auth and not anon) from f) and (select count(*) from f) = 2, ''
)
select item, ok, detail from checks order by ok, item;
