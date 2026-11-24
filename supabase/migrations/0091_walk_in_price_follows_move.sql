-- 0091 — A desk walk-in's price follows a staff move (staff-operations audit, 24 Nov).
--
-- The defect: move_booking changes a booking's court, time or length but never its price. A walk-in booked at the
-- desk for 1 h ($20) and then stretched to 2 h, or moved from an off-peak hour into a peak one, kept $20. The staff
-- calendar then told the desk "$20.00 · take payment at the desk", and the club undercharged (or overcharged when
-- shortened).
--
-- The fix, for desk walk-ins only (source 'staff': no CourtBook payment, no fee): after the move, the price is the
-- club's price for the new court, time and length (quote_price, as staff_book does).
--
-- App bookings keep their price. The player agreed it, and paid it if the club takes app payments; repricing would
-- disagree with the money taken. An app booking at a club that takes payment at its desk, whose LENGTH staff change,
-- is a product decision left for Paul (recorded in the master checklist).
--
-- Rebuilt from pg_get_functiondef of a 0001–0090 database (the 0063 rule); the only change is the lines marked
-- "0091". Same signature, so grants are untouched. Safe to re-run.
create or replace function public.move_booking(p_booking uuid, p_court uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
  if b.end_at <= now() then raise exception 'booking_ended'; end if;
  if p_start < now() and not (p_start = b.start_at and p_end > now()) then
    raise exception 'move_into_past';
  end if;
  if not exists (select 1 from courts where id = p_court and club_id = b.club_id and active) then
    raise exception 'court_not_found';
  end if;
  select * into c from clubs where id = b.club_id;
  if (p_end - p_start) <> (b.end_at - b.start_at)
     and (p_end - p_start) not between make_interval(mins => c.min_booking_minutes) and make_interval(mins => c.max_booking_minutes) then
    raise exception 'bad_duration';
  end if;
  update bookings set court_id = p_court, start_at = p_start, end_at = p_end where id = p_booking;
  if b.source = 'staff' then                                                                        -- 0091
    update bookings set price_usd = quote_price(p_court, p_start, p_end) where id = p_booking;       -- 0091
  end if;                                                                                           -- 0091
exception
  when exclusion_violation then
    raise exception 'slot_taken';
end $function$;
