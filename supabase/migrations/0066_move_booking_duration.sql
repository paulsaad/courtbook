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
