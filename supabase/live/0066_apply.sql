-- 0066 for the LIVE database, all or nothing. Run once in Supabase → SQL Editor on the live project,
-- AFTER 0066_preflight.sql showed every row ok.
-- One transaction: checks move_booking is exactly the verified pre-0066 version (code compared ignoring
-- Windows line endings), runs migration 0066 unchanged, then checks the result is the verified 0066
-- version with unchanged permissions. Any failure rolls back everything. A second run stops at the first
-- check and changes nothing.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $pre$
declare n int; body text; f oid;
begin
  select count(*), max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))), max(oid) into n, body, f
  from pg_proc where proname = 'move_booking' and pronamespace = 'public'::regnamespace;
  if n <> 1 or body <> '8738160b4251b3e78f6b713f6f9183c2' then
    raise exception 'STOPPED, nothing changed: move_booking is not the verified pre-0066 version (count %, code %)', n, body;
  end if;
  if has_function_privilege('anon', f, 'execute') or not has_function_privilege('authenticated', f, 'execute')
     or not has_function_privilege('service_role', f, 'execute') then
    raise exception 'STOPPED, nothing changed: move_booking permissions are not anon=no, authenticated=yes, service_role=yes';
  end if;
end $pre$;

-- ===== migration 0066, unchanged from supabase/migrations/0066_move_booking_duration.sql =====
-- A staff move must respect the club's minimum and maximum booking length, as staff_book,
-- book_at_desk and hold_slot already do. Found 2026-11-14 while checking the live drift: the
-- bookings_slot_validation trigger checks grid, whole slots and opening hours, but not min/max, and
-- move_booking had no check of its own — a 1 h booking could be stretched to 4 h (max 3 h) or cut
-- to 30 min (min 1 h).
--
-- A move that keeps the booking's existing length is always allowed: the booking was valid when it
-- was made, and the club may have changed its limits since; refusing would make it impossible to
-- move to another court or time. Only a new length is checked.
--
-- Rebuilt from pg_get_functiondef of a 0001–0065 database (the 0063 rule); the only change is the
-- two lines marked "0066". Same signature, so grants are untouched. Safe to re-run.
create or replace function move_booking(p_booking uuid, p_court uuid, p_start timestamptz, p_end timestamptz)
returns void
language plpgsql security definer set search_path = public as $$
declare v_court uuid; b bookings%rowtype; c clubs%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select court_id into v_court from bookings where id = p_booking;
  if not found then raise exception 'not_found'; end if;
  perform lock_courts(array_remove(array[v_court, p_court], null));
  select * into b from bookings where id = p_booking for update;
  if not is_staff_of(b.club_id) then raise exception 'forbidden'; end if;
  if b.status <> 'confirmed' then raise exception 'not_confirmed'; end if;
  if b.court_id is null then raise exception 'not_a_court_booking'; end if;
  if p_start >= p_end then raise exception 'bad_range'; end if;
  if not exists (select 1 from courts where id = p_court and club_id = b.club_id and active) then
    raise exception 'court_not_found';
  end if;
  select * into c from clubs where id = b.club_id;                                                   -- 0066
  if (p_end - p_start) <> (b.end_at - b.start_at)                                                    -- 0066
     and (p_end - p_start) not between make_interval(mins => c.min_booking_minutes) and make_interval(mins => c.max_booking_minutes) then
    raise exception 'bad_duration';
  end if;
  update bookings set court_id = p_court, start_at = p_start, end_at = p_end where id = p_booking;
exception
  when exclusion_violation then
    raise exception 'slot_taken';
end $$;
-- ===== end of migration 0066 =====

do $post$
declare n int; body text; f oid;
begin
  select count(*), max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))), max(oid) into n, body, f
  from pg_proc where proname = 'move_booking' and pronamespace = 'public'::regnamespace;
  if n <> 1 or body <> 'c529f2516aa80bc9dd6b3676e43d2565' then
    raise exception 'ROLLED BACK: move_booking after 0066 is not the verified version (count %, code %)', n, body;
  end if;
  if has_function_privilege('anon', f, 'execute') or not has_function_privilege('authenticated', f, 'execute')
     or not has_function_privilege('service_role', f, 'execute') then
    raise exception 'ROLLED BACK: move_booking permissions are not anon=no, authenticated=yes, service_role=yes';
  end if;
end $post$;

notify pgrst, 'reload schema';
commit;
select 'move_booking is now the 0066 version' as result;
