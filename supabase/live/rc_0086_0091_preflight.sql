-- Release candidate 0086–0092 — PREFLIGHT. READ ONLY: one SELECT, changes nothing.
-- Part 1 rows must all be ok before applying; part 2 is information to note in the run log.
with checks(part, item, ok, detail) as (
  select 1, '0085 is applied (club_readable_by_me exists)', to_regprocedure('club_readable_by_me(uuid,boolean)') is not null, ''
  union all select 1, 'nothing of 0086–0092 is here yet (no half-applied release)',
    to_regclass('public.deletion_worker') is null and to_regclass('public.club_favourites') is null and to_regclass('public.player_areas') is null
    and to_regclass('public.player_prefs') is null and to_regprocedure('quote_move(uuid,uuid,timestamptz,timestamptz)') is null
    and to_regprocedure('set_club_base_prices(uuid,numeric,jsonb,boolean)') is null,
    concat_ws(',', case when to_regclass('public.deletion_worker') is not null then 'deletion_worker' end, case when to_regclass('public.club_favourites') is not null then 'club_favourites' end,
      case when to_regclass('public.player_areas') is not null then 'player_areas' end, case when to_regprocedure('quote_move(uuid,uuid,timestamptz,timestamptz)') is not null then 'quote_move' end,
      case when to_regprocedure('set_club_base_prices(uuid,numeric,jsonb,boolean)') is not null then 'set_club_base_prices' end)
  union all select 1, 'account_deletions has only statuses 0086 knows (requested, cancelled, done)',
    not exists (select 1 from account_deletions where status not in ('requested', 'cancelled', 'done')),
    coalesce((select string_agg(distinct status, ',') from account_deletions where status not in ('requested', 'cancelled', 'done')), '')
  union all select 1, 'no booking overlaps another live booking or a block (the starting point is clean)',
    not exists (select 1 from bookings a join bookings b on a.court_id = b.court_id and a.id < b.id and a.status in ('confirmed','pending') and b.status in ('confirmed','pending') and a.period && b.period)
    and not exists (select 1 from bookings k join blocks x on x.court_id = k.court_id and x.period && k.period where k.status in ('confirmed','pending')), ''
  union all select 1, 'every pending payment belongs to a pending booking',
    not exists (select 1 from payments p join bookings b on b.id = p.booking_id where p.status = 'pending' and b.status <> 'pending'), ''
  -- information
  union all select 2, 'open old-style deletion requests (0086 keeps them as requests; promoted after 24 h once R1 runs)',
    true, (select count(*)::text from account_deletions where status = 'requested')
  union all select 2, 'published clubs without an exact map point (0089: stay published; cannot be re-published until set)',
    true, (select count(*)::text from clubs where active and (lat is null or lng is null))
  union all select 2, 'clubs with a half-filled map point (0088''s rule is NOT VALID: existing rows are not rewritten)',
    true, (select count(*)::text from clubs where (lat is null) <> (lng is null))
  union all select 2, 'expired holds not yet swept (0090 lets their late payments confirm)',
    true, (select count(*)::text from bookings where status = 'pending' and hold_expires_at < now())
  union all select 2, 'upcoming desk walk-ins (0091: a move that changes their price needs the desk to confirm it)',
    true, (select count(*)::text from bookings where source = 'staff' and status = 'confirmed' and start_at > now())
  union all select 2, 'upcoming bookings on courts already switched off (hidden from the staff calendar; 0092 stops new cases, these need the desk)',
    true, (select count(*)::text from bookings b join courts c on c.id = b.court_id where not c.active and b.status in ('confirmed', 'pending') and b.end_at > now())
  union all select 2, 'public tables that 0086 gives the account lock-out trigger',
    true, (select count(*)::text from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') and c.relname <> 'account_deletions')
)
select part, item, ok, detail from checks order by part, ok, item;
