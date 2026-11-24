-- M12.1 (0093 fee_online payments) — PREFLIGHT. READ ONLY: one SELECT, changes nothing.
-- Part 1 rows must all be ok before applying 0093; part 2 is information to note in the run log.
with checks(part, item, ok, detail) as (
  select 1, '0090 is applied (late confirmation of an expired hold: the trigger skips the row being written)',
    position('id <> new.id' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('reject_booking_over_block()')), '')) > 0, ''
  union all select 1, '0091 is applied (move_price_plan, which 0093 replaces)',
    to_regprocedure('move_price_plan(bookings,uuid,timestamptz,timestamptz)') is not null and to_regprocedure('quote_move(uuid,uuid,timestamptz,timestamptz)') is not null, ''
  union all select 1, '0092 is applied (set_club_base_prices, courts keep booked active)',
    to_regprocedure('set_club_base_prices(uuid,numeric,jsonb,boolean)') is not null and to_regprocedure('bookings_need_active_court()') is not null, ''
  union all select 1, '0086–0089 are applied (deletion worker, favourites, playing areas)',
    to_regclass('public.deletion_worker') is not null and to_regclass('public.club_favourites') is not null and to_regclass('public.player_areas') is not null, ''
  union all select 1, 'nothing of 0093 is here yet (no half-applied migration)',
    to_regclass('public.payment_attempts') is null and to_regclass('public.fee_charges') is null
    and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'payments' and column_name = 'kind')
    and to_regprocedure('record_attempt_result(uuid,text,text,numeric,text)') is null, ''
  union all select 1, 'every club is in a mode 0093 keeps (simulated or at_desk)',
    not exists (select 1 from clubs where payment_mode not in ('simulated', 'at_desk')),
    coalesce((select string_agg(distinct payment_mode, ',') from clubs where payment_mode not in ('simulated', 'at_desk')), '')
  union all select 1, 'simulated payment only at demo clubs (0070 still holds)',
    not exists (select 1 from clubs where payment_mode = 'simulated' and not is_demo), ''
  union all select 1, 'no real payment provider is configured in the database (real payments stay off)',
    coalesce(nullif(current_setting('app.payment_provider', true), ''), 'simulated') = 'simulated',
    coalesce(nullif(current_setting('app.payment_provider', true), ''), '(unset)')
  union all select 1, 'every pending payment belongs to a pending booking',
    not exists (select 1 from payments p join bookings b on b.id = p.booking_id where p.status = 'pending' and b.status <> 'pending'), ''
  union all select 1, 'no booking overlaps another live booking or a block (the starting point is clean)',
    not exists (select 1 from bookings a join bookings b on a.court_id = b.court_id and a.id < b.id and a.status in ('confirmed','pending') and b.status in ('confirmed','pending') and a.period && b.period)
    and not exists (select 1 from bookings k join blocks x on x.court_id = k.court_id and x.period && k.period where k.status in ('confirmed','pending')), ''
  union all select 1, 'every payment provider is one 0093 knows',
    not exists (select 1 from payments where provider not in ('simulated', 'whish', 'areeba')), ''
  -- information
  union all select 2, 'payments by provider and status (all become kind court_and_fee)',
    true, coalesce((select string_agg(provider || ':' || status || '=' || n, ', ' order by provider, status) from (select provider, status::text, count(*) n from payments group by 1, 2) x), 'none')
  union all select 2, 'pending holds right now (any mode change after 0093 releases them)',
    true, (select count(*)::text from bookings where status = 'pending')
  union all select 2, 'clubs by mode (demo / real)',
    true, coalesce((select string_agg(payment_mode || ':' || case when is_demo then 'demo' else 'real' end || '=' || n, ', ') from (select payment_mode, is_demo, count(*) n from clubs group by 1, 2) x), 'none')
  union all select 2, 'refunds due in the club queue now (court_and_fee; unchanged by 0093)',
    true, (select count(*)::text from payments where status = 'refund_due' and collected)
)
select part, item, ok, detail from checks order by part, ok, item;
