-- 0086 alone — POSTCHECK (step 1 of docs/ops/release-candidate-staging.md). READ ONLY: one SELECT, changes nothing.
-- Rows item|ok|detail; every row must be ok = true. The release-candidate postcheck needs 0087–0092 as well, so this
-- file checks only what 0086 adds, and that nothing after it is present.
with fn(name, sig) as (values
  ('close_my_account', 'close_my_account(text)'), ('close_account_internal', 'close_account_internal(uuid,text)'),
  ('claim_deletion', 'claim_deletion(uuid,integer)'), ('record_deletion_step', 'record_deletion_step(uuid,uuid,text,text)'),
  ('finish_account_deletion', 'finish_account_deletion(uuid)'), ('promote_due_requests', 'promote_due_requests(interval)'),
  ('recently_authenticated', 'recently_authenticated(interval)'), ('record_deletion_worker_run', 'record_deletion_worker_run(jsonb)'),
  ('deletion_processing_active', 'deletion_processing_active()'), ('refuse_writes_by_closed_account', 'refuse_writes_by_closed_account()'),
  ('admin_deletion_worker', 'admin_deletion_worker()'), ('release_held_deletion', 'release_held_deletion(uuid)')),
checks(item, ok, detail) as (
  select 'every 0086 function exists', bool_and(to_regprocedure(sig) is not null),
    coalesce(string_agg(name, ',') filter (where to_regprocedure(sig) is null), '') from fn
  union all select 'deletion_worker exists with row-level security on and no policy (read through functions only)',
    coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.deletion_worker')), false)
    and not exists (select 1 from pg_policy where polrelid = to_regclass('public.deletion_worker')), ''
  union all select 'the account lock-out trigger is on every public table except account_deletions and deletion_worker',
    not exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') and c.relname not in ('account_deletions', 'deletion_worker')
      and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'closed_account_lockout')),
    coalesce((select string_agg(c.relname, ',') from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') and c.relname not in ('account_deletions', 'deletion_worker')
      and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'closed_account_lockout')), '')
  union all select 'players cannot record worker runs, promote requests or claim deletions; visitors cannot close accounts',
    not has_function_privilege('authenticated', 'record_deletion_worker_run(jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'promote_due_requests(interval)', 'execute')
    and not has_function_privilege('authenticated', 'claim_deletion(uuid,integer)', 'execute')
    and not has_function_privilege('anon', 'close_my_account(text)', 'execute'), ''
  union all select 'old apps keep their calls (request, cancel, status granted to signed-in players)',
    has_function_privilege('authenticated', 'request_account_deletion(text)', 'execute')
    and has_function_privilege('authenticated', 'cancel_account_deletion()', 'execute')
    and has_function_privilege('authenticated', 'my_account_deletion()', 'execute'), ''
  union all select 'new app closing is gated: the retry worker has not run (expected before step 3)',
    not deletion_processing_active(), coalesce((select last_run_at::text from deletion_worker), 'no run yet')
  union all select 'account_deletions statuses are ones 0086 knows',
    not exists (select 1 from account_deletions where status not in ('requested', 'cancelled', 'closing', 'closed', 'held', 'data_removed', 'done')),
    coalesce((select string_agg(distinct status::text, ',') from account_deletions), 'no rows')
  union all select 'nothing after 0086 is present (0087–0092 not applied)',
    to_regclass('public.club_favourites') is null and to_regclass('public.player_areas') is null
    and to_regprocedure('quote_move(uuid,uuid,timestamptz,timestamptz)') is null
    and to_regprocedure('set_club_base_prices(uuid,numeric,jsonb,boolean)') is null
    and pg_get_functiondef('reject_booking_over_block'::regproc) not like '%id <> new.id%', ''
  union all select 'still clean: no overlapping live bookings, none over a block, pending payments match pending bookings',
    not exists (select 1 from bookings a join bookings b on a.court_id = b.court_id and a.id < b.id and a.status in ('confirmed','pending') and b.status in ('confirmed','pending') and a.period && b.period)
    and not exists (select 1 from bookings k join blocks x on x.court_id = k.court_id and x.period && k.period where k.status in ('confirmed','pending'))
    and not exists (select 1 from payments p join bookings b on b.id = p.booking_id where p.status = 'pending' and b.status <> 'pending'), ''
)
select item, ok, detail from checks order by ok, item;
