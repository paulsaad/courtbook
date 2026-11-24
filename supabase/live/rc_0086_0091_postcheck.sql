-- Release candidate 0086–0091 — POSTCHECK. READ ONLY: one SELECT, changes nothing. Every row must be ok = true.
with fn(name, sig) as (values
  ('close_my_account', 'close_my_account(text)'), ('record_deletion_step', 'record_deletion_step(uuid,uuid,text,text)'),
  ('promote_due_requests', 'promote_due_requests(interval)'), ('recently_authenticated', 'recently_authenticated(interval)'),
  ('set_club_favourite', 'set_club_favourite(uuid,boolean)'), ('set_playing_areas', 'set_playing_areas(jsonb)'),
  ('dismiss_areas_question', 'dismiss_areas_question()'), ('quote_move', 'quote_move(uuid,uuid,timestamptz,timestamptz)'),
  ('move_booking_priced', 'move_booking_priced(uuid,uuid,timestamptz,timestamptz,numeric)')),
checks(item, ok, detail) as (
  select 'every new function exists', bool_and(to_regprocedure(sig) is not null), coalesce(string_agg(name, ',') filter (where to_regprocedure(sig) is null), '') from fn
  union all select 'new tables exist with row-level security on',
    (select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('deletion_worker'::regclass, 'club_favourites'::regclass, 'player_areas'::regclass, 'player_prefs'::regclass)), ''
  union all select 'the account lock-out trigger is on every public table except account_deletions and deletion_worker',
    not exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') and c.relname not in ('account_deletions', 'deletion_worker')
      and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'closed_account_lockout')),
    coalesce((select string_agg(c.relname, ',') from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') and c.relname not in ('account_deletions', 'deletion_worker')
      and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'closed_account_lockout')), '')
  union all select 'players cannot record worker runs or promote requests; visitors cannot move or quote',
    not has_function_privilege('authenticated', 'record_deletion_worker_run(jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'promote_due_requests(interval)', 'execute')
    and not has_function_privilege('anon', 'move_booking_priced(uuid,uuid,timestamptz,timestamptz,numeric)', 'execute')
    and not has_function_privilege('anon', 'quote_move(uuid,uuid,timestamptz,timestamptz)', 'execute'), ''
  union all select 'old apps keep their calls (request, cancel, status granted to signed-in players)',
    has_function_privilege('authenticated', 'request_account_deletion(text)', 'execute') and has_function_privilege('authenticated', 'cancel_account_deletion()', 'execute')
    and has_function_privilege('authenticated', 'my_account_deletion()', 'execute'), ''
  union all select 'app deletion is gated until the retry worker runs (no heartbeat yet is expected)',
    not deletion_processing_active(), coalesce((select last_run_at::text from deletion_worker), 'no run yet')
  union all select '0090: the booking block check leaves the row being written alone',
    pg_get_functiondef('reject_booking_over_block'::regproc) like '%id <> new.id%', ''
  union all select '0091: the older move call cannot change a price',
    pg_get_functiondef('move_booking(uuid,uuid,timestamptz,timestamptz)'::regprocedure) like '%move_booking_priced(p_booking, p_court, p_start, p_end, null)%', ''
  union all select '0092 (step 6b; ok before it is applied): booked courts stay active, visitors cannot set prices',
    to_regprocedure('set_club_base_prices(uuid,numeric,jsonb,boolean)') is null
    or (exists (select 1 from pg_trigger where tgname = 'courts_keep_booked_active' and tgrelid = 'courts'::regclass)
        and not has_function_privilege('anon', 'set_club_base_prices(uuid,numeric,jsonb,boolean)', 'execute')),
    case when to_regprocedure('set_club_base_prices(uuid,numeric,jsonb,boolean)') is null then 'not applied yet' else 'applied' end
  union all select '0089: publishing requires the map point', pg_get_functiondef('club_readiness_rows'::regproc) like '%c.lat is not null and c.lng is not null%', ''
  union all select 'still clean: no overlapping live bookings, none over a block, payments match bookings',
    not exists (select 1 from bookings a join bookings b on a.court_id = b.court_id and a.id < b.id and a.status in ('confirmed','pending') and b.status in ('confirmed','pending') and a.period && b.period)
    and not exists (select 1 from bookings k join blocks x on x.court_id = k.court_id and x.period && k.period where k.status in ('confirmed','pending'))
    and not exists (select 1 from payments p join bookings b on b.id = p.booking_id where p.status = 'pending' and b.status <> 'pending'), ''
)
select item, ok, detail from checks order by ok, item;
