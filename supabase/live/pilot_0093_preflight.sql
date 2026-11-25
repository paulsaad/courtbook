-- 0093 (pilot, PR-8: closed-account refusal under the profile lock) — PREFLIGHT. READ ONLY: one SELECT, changes
-- nothing. Part 1 rows must all be ok before applying 0093; part 2 is information to note in the run log.
-- Fingerprints are md5(prosrc) of the definitions 0093 replaces, as a 0001–0092 database has them (book_at_desk's is the
-- one staging itself reported on 24 Nov); 0093 may only replace exactly these texts.
with checks(part, item, ok, detail) as (
  select 1, '0086 is applied (deletion_requested, account_deletions)',
    to_regprocedure('deletion_requested(uuid)') is not null and to_regclass('public.account_deletions') is not null, ''
  union all select 1, '0087–0092 are applied (favourites, playing areas, move_price_plan, set_club_base_prices)',
    to_regclass('public.club_favourites') is not null and to_regclass('public.player_areas') is not null
    and to_regprocedure('move_price_plan(bookings,uuid,timestamptz,timestamptz)') is not null
    and to_regprocedure('set_club_base_prices(uuid,numeric,jsonb,boolean)') is not null
    and to_regprocedure('bookings_need_active_court()') is not null, ''
  union all select 1, 'nothing after 0093 is here (no M12 table: payment_attempts)',
    to_regclass('public.payment_attempts') is null, ''
  union all select 1, 'book_at_desk is exactly the 0053 text 0093 replaces',
    coalesce((select md5(prosrc) from pg_proc where oid = to_regprocedure('book_at_desk(uuid,timestamptz,timestamptz,uuid)')), '') = 'f199829493c2fc40ef9080b10649d88c',
    coalesce((select md5(prosrc) from pg_proc where oid = to_regprocedure('book_at_desk(uuid,timestamptz,timestamptz,uuid)')), 'missing')
  union all select 1, 'hold_slot is exactly the 0065 text 0093 replaces',
    coalesce((select md5(prosrc) from pg_proc where oid = to_regprocedure('hold_slot(uuid,uuid,timestamptz,timestamptz,uuid)')), '') = '6003eef1bc05a95409b35e064367f903',
    coalesce((select md5(prosrc) from pg_proc where oid = to_regprocedure('hold_slot(uuid,uuid,timestamptz,timestamptz,uuid)')), 'missing')
  union all select 1, 'request_account_deletion is exactly the 0086 text 0093 replaces',
    coalesce((select md5(prosrc) from pg_proc where oid = to_regprocedure('request_account_deletion(text)')), '') = 'be8d4dfa23b340d8e9c3911720900ca1',
    coalesce((select md5(prosrc) from pg_proc where oid = to_regprocedure('request_account_deletion(text)')), 'missing')
  union all select 1, 'deletion_requested is the 0086 text 0093 relies on (the five open states)',
    coalesce((select md5(prosrc) from pg_proc where oid = to_regprocedure('deletion_requested(uuid)')), '') = 'dbb82744ee949b8113b676e86edac4cc',
    coalesce((select md5(prosrc) from pg_proc where oid = to_regprocedure('deletion_requested(uuid)')), 'missing')
  union all select 1, 'the three functions run as their owner with search_path public; only signed-in people and the service role may call them',
    (select bool_and(p.prosecdef and p.proconfig = array['search_path=public']
                     and has_function_privilege('authenticated', p.oid, 'execute') and has_function_privilege('service_role', p.oid, 'execute')
                     and not has_function_privilege('anon', p.oid, 'execute'))
       from pg_proc p where p.oid in (to_regprocedure('book_at_desk(uuid,timestamptz,timestamptz,uuid)'),
                                      to_regprocedure('hold_slot(uuid,uuid,timestamptz,timestamptz,uuid)'),
                                      to_regprocedure('request_account_deletion(text)'))), ''
  -- information
  union all select 2, 'deletion records by status (counts only)',
    true, coalesce((select string_agg(status || '=' || n, ', ' order by status) from (select status, count(*) n from account_deletions group by 1) x), 'none')
  union all select 2, 'deletion runs holding a lease right now (a run in progress is not affected; noted for the log)',
    true, (select count(*)::text from account_deletions where lease_until > now())
  union all select 2, 'live future bookings of accounts in the deletion set (the deletion run cancels these; 0093 changes nothing about them)',
    true, (select count(*)::text from bookings where status in ('confirmed', 'pending') and end_at > now() and deletion_requested(player_id))
)
select part, item, ok, detail from checks order by part, ok, item;
