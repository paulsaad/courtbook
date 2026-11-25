-- 0095 (deletion vs booking lock order) — PREFLIGHT. READ ONLY: one SELECT, changes nothing. Part 1 must all be ok.
-- 0095 replaces hold_slot and book_at_desk with their exact previous text plus one check, so it may only be applied
-- over exactly that previous text (hold_slot from 0093, book_at_desk from 0053): anything else would be overwritten.
with f as (
  select p.proname, md5(p.prosrc) as src, p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') as cfg,
         has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as auth
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('hold_slot', 'book_at_desk')
), checks(part, item, ok, detail) as (
  select 1, '0086 and 0093 are applied (deletion_requested, payment attempts), and 0094 before it',
    to_regprocedure('deletion_requested(uuid)') is not null and to_regclass('public.payment_attempts') is not null
    and to_regclass('public.payment_reconciliation') is not null, ''
  union all select 1, 'exactly one hold_slot and one book_at_desk',
    (select count(*) from f where proname = 'hold_slot') = 1 and (select count(*) from f where proname = 'book_at_desk') = 1,
    (select string_agg(proname, ',') from f)
  union all select 1, 'hold_slot is exactly 0093''s (0095 not applied, nothing else changed it)',
    (select src from f where proname = 'hold_slot') = 'fa85f3ca2561a97afbe87e2c756b4562',
    coalesce((select src from f where proname = 'hold_slot'), 'missing')
  union all select 1, 'book_at_desk is exactly 0053''s (0095 not applied, nothing else changed it)',
    (select src from f where proname = 'book_at_desk') = 'f199829493c2fc40ef9080b10649d88c',
    coalesce((select src from f where proname = 'book_at_desk'), 'missing')
  union all select 1, 'both run as their owner with search_path=public; signed-in may call them, visitors may not (0095 keeps this)',
    (select bool_and(prosecdef and cfg = 'search_path=public' and auth and not anon) from f), ''
  union all select 2, 'open deletion requests now (counts only; 0095 refuses their bookings earlier, same answer)',
    true, (select count(*)::text from account_deletions where status in ('requested', 'closing', 'closed', 'held', 'data_removed'))
)
select part, item, ok, detail from checks order by part, ok, item;
