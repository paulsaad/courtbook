-- Release candidate 0087–0092, applied after 0086 (staging: 0086 is already applied, step 1, 24 Nov) — PREFLIGHT.
-- READ ONLY: one SELECT, changes nothing. Part 1 rows must all be ok before applying 0087–0092; part 2 is information.
-- rc_0086_0091_preflight.sql cannot be used once 0086 is applied: its "nothing of 0086–0092" row requires deletion_worker
-- to be absent.
with checks(part, item, ok, detail) as (
  select 1, '0085 is applied (club_readable_by_me exists)', to_regprocedure('club_readable_by_me(uuid,boolean)') is not null, ''
  union all select 1, '0086 is applied (deletion worker, one-confirmation closing, account lock-out trigger)',
    to_regclass('public.deletion_worker') is not null and to_regprocedure('close_my_account(text)') is not null
    and to_regprocedure('record_deletion_step(uuid,uuid,text,text)') is not null and to_regprocedure('promote_due_requests(interval)') is not null
    and exists (select 1 from pg_trigger where tgname = 'closed_account_lockout'), ''
  union all select 1, 'nothing of 0087–0092 is here yet (no half-applied release)',
    to_regclass('public.club_favourites') is null and to_regclass('public.player_areas') is null and to_regclass('public.player_prefs') is null
    and to_regprocedure('quote_move(uuid,uuid,timestamptz,timestamptz)') is null
    and to_regprocedure('set_club_base_prices(uuid,numeric,jsonb,boolean)') is null
    and position('id <> new.id' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('reject_booking_over_block()')), '')) = 0,
    concat_ws(',', case when to_regclass('public.club_favourites') is not null then 'club_favourites' end,
      case when to_regclass('public.player_areas') is not null then 'player_areas' end, case when to_regclass('public.player_prefs') is not null then 'player_prefs' end,
      case when to_regprocedure('quote_move(uuid,uuid,timestamptz,timestamptz)') is not null then 'quote_move' end,
      case when to_regprocedure('set_club_base_prices(uuid,numeric,jsonb,boolean)') is not null then 'set_club_base_prices' end)
  union all select 1, 'every public table but account_deletions and deletion_worker has the lock-out trigger (0087–0089 add theirs)',
    not exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') and c.relname not in ('account_deletions', 'deletion_worker')
      and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'closed_account_lockout')),
    coalesce((select string_agg(c.relname, ',') from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') and c.relname not in ('account_deletions', 'deletion_worker')
      and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'closed_account_lockout')), '')
  -- 26 Nov: the list was copied from rc_0086_0091_preflight (BEFORE 0086, when only these three existed) and refused every
  -- deletion open in a 0086 state (closing, closed, held, data_removed) — a false stop at step A, since 0087–0092 do not
  -- touch deletion (open deletions are reported in part 2 below). Now: the statuses 0086 itself allows.
  union all select 1, 'account_deletions has only statuses 0086 knows (requested, cancelled, closing, closed, held, data_removed, done)',
    not exists (select 1 from account_deletions where status not in ('requested', 'cancelled', 'closing', 'closed', 'held', 'data_removed', 'done')),
    coalesce((select string_agg(distinct status, ',') from account_deletions where status not in ('requested', 'cancelled', 'closing', 'closed', 'held', 'data_removed', 'done')), '')
  union all select 1, 'no booking overlaps another live booking or a block (the starting point is clean)',
    not exists (select 1 from bookings a join bookings b on a.court_id = b.court_id and a.id < b.id and a.status in ('confirmed','pending') and b.status in ('confirmed','pending') and a.period && b.period)
    and not exists (select 1 from bookings k join blocks x on x.court_id = k.court_id and x.period && k.period where k.status in ('confirmed','pending')), ''
  union all select 1, 'every pending payment belongs to a pending booking',
    not exists (select 1 from payments p join bookings b on b.id = p.booking_id where p.status = 'pending' and b.status <> 'pending'), ''
  -- information
  union all select 2, 'open deletion requests (the retry worker promotes them; 0087–0092 do not touch deletion)',
    true, (select count(*)::text from account_deletions where status = 'requested')
  union all select 2, 'published clubs without an exact map point (0089: stay published; cannot be re-published until set)',
    true, (select count(*)::text from clubs where active and (lat is null or lng is null))
  union all select 2, 'clubs with a half-filled map point (0088''s rule is NOT VALID: existing rows are not rewritten)',
    true, (select count(*)::text from clubs where (lat is null) <> (lng is null))
  union all select 2, 'expired holds not yet swept (0090 lets their late payments confirm)',
    true, (select count(*)::text from bookings where status = 'pending' and hold_expires_at < now())
  union all select 2, 'upcoming desk walk-ins (0091: a move that changes their price needs the desk to confirm it)',
    true, (select count(*)::text from bookings where source = 'staff' and status = 'confirmed' and start_at > now())
  union all select 2, 'published clubs with offered start times that have no price (0092 then refuses their longer hours and price edits until priced; players see times they cannot book)',
    true, coalesce((select string_agg(c.slug, ', ') from clubs c where c.active and not c.is_demo
      and exists (select 1 from club_readiness_rows(c.id) r where r.item = 'prices' and not r.ok)), 'none')
  union all select 2, 'upcoming bookings on courts already switched off (hidden from the staff calendar; 0092 stops new cases, these need the desk)',
    true, (select count(*)::text from bookings b join courts c on c.id = b.court_id where not c.active and b.status in ('confirmed', 'pending') and b.end_at > now())
  union all select 2, 'deletion records by status (counts only)',
    true, coalesce((select string_agg(status || '=' || n, ', ' order by status) from (select status, count(*) n from account_deletions group by 1) x), 'none')
)
select part, item, ok, detail from checks order by part, ok, item;
