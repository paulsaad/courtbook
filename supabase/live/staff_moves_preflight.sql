-- F1 (staff moves check what the desk saw): READ-ONLY preflight, run before docs/staff-moves/sql/move_checks_what_desk_saw.draft.sql.
-- Every line must end in OK. Any STOP: do not apply; report it. Changes nothing (selects only).
--   psql "$DB" -X -At -F'|' -f supabase/live/staff_moves_preflight.sql
select 'F1 move_booking_priced (5 arguments) is exactly 0091''s', md5(prosrc), case when md5(prosrc) = 'b44d992c944deb64e6eab6052d3da223' then 'OK' else 'STOP' end
  from pg_proc where oid = to_regprocedure('public.move_booking_priced(uuid,uuid,timestamptz,timestamptz,numeric)')
union all select 'F1 move_booking_priced (5 arguments) is exactly 0091''s', 'missing', 'STOP'
  where to_regprocedure('public.move_booking_priced(uuid,uuid,timestamptz,timestamptz,numeric)') is null
union all
select 'F2 move_booking (4 arguments) is exactly 0091''s', md5(prosrc), case when md5(prosrc) = 'e4d8d8a1740d9ad5c1df730252056edf' then 'OK' else 'STOP' end
  from pg_proc where oid = to_regprocedure('public.move_booking(uuid,uuid,timestamptz,timestamptz)')
union all select 'F2 move_booking (4 arguments) is exactly 0091''s', 'missing', 'STOP'
  where to_regprocedure('public.move_booking(uuid,uuid,timestamptz,timestamptz)') is null
union all
select 'F3 the 8-argument move_booking_priced does not exist yet',
  coalesce(to_regprocedure('public.move_booking_priced(uuid,uuid,timestamptz,timestamptz,numeric,uuid,timestamptz,timestamptz)')::text, 'absent'),
  case when to_regprocedure('public.move_booking_priced(uuid,uuid,timestamptz,timestamptz,numeric,uuid,timestamptz,timestamptz)') is null then 'OK' else 'STOP' end
union all
select 'F4 no policy lets a signed-in user update bookings directly', count(*)::text, case when count(*) = 0 then 'OK' else 'STOP' end
  from pg_policies where schemaname = 'public' and tablename = 'bookings' and cmd in ('UPDATE', 'ALL')
union all
select 'F5 quote_move and move_price_plan exist (0091)', count(*)::text, case when count(*) = 2 then 'OK' else 'STOP' end
  from pg_proc where pronamespace = 'public'::regnamespace and proname in ('quote_move', 'move_price_plan')
union all
select 'F6 no other function calls move_booking or move_booking_priced', coalesce(string_agg(proname, ','), 'none'), case when count(*) = 0 then 'OK' else 'STOP' end
  from pg_proc where pronamespace = 'public'::regnamespace and proname not in ('move_booking', 'move_booking_priced')
   and prosrc ~ 'move_booking(_priced)?\s*\(';
