-- D3 (release audit, approved 17 Nov 2026): staff and past times.
--
-- staff_book: a desk booking may start in the past only for a walk-in that started within the last
--   2 hours (start >= now() - 2 h). Older starts are refused with `walk_in_too_old`. Future bookings
--   are unchanged. The window is measured in real time (UTC), so it behaves the same across local
--   midnight and on the nights Beirut's clocks change.
-- move_booking: a booking cannot be moved to a time that has passed (`move_into_past`). One case stays
--   allowed because the staff calendar offers "Move" on a booking that is being played: a booking that
--   is in progress (started, not yet ended) may change court or end time as long as it keeps its own
--   start time and still ends in the future. Moving its start earlier or later into the past, or
--   re-timing a booking that has already ended while keeping a past start, is refused. Moving any
--   booking to a future time is unchanged.
--
-- Everything else is unchanged: duration rules, grid and opening hours (assert_valid_court_slot and the
-- bookings_slot_validation trigger), lock order, and the exclusion constraint that makes a double
-- booking impossible (`slot_taken`).
--
-- Rebuilt from pg_get_functiondef of a 0001–0066 database; the only changes are the lines marked
-- "0071". Same signatures, so grants are untouched. Safe to re-run.

create or replace function public.staff_book(p_club uuid, p_court uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_name text, p_phone text default null::text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  c clubs%rowtype;
  v_mins numeric;
  v_price numeric;
  v_id uuid := gen_random_uuid();
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not (is_staff_of(p_club) or is_admin()) then raise exception 'forbidden'; end if;
  if v_name is null then raise exception 'name_required'; end if;
  if length(v_name) > 80 or length(coalesce(p_phone, '')) > 30 then raise exception 'too_long'; end if;

  select * into c from clubs where id = p_club and active;
  if not found then raise exception 'club_not_found'; end if;
  -- the court must belong to THIS club and be active
  if not exists (select 1 from courts where id = p_court and club_id = p_club and active) then
    raise exception 'court_not_found';
  end if;

  v_mins := extract(epoch from (p_end - p_start)) / 60;
  if v_mins < c.min_booking_minutes or v_mins > c.max_booking_minutes then raise exception 'bad_duration'; end if;
  if p_start < now() - interval '2 hours' then raise exception 'walk_in_too_old'; end if;            -- 0071

  -- same lock order as hold_slot (courts before bookings), and clear any hold that has run out
  perform lock_courts(array[p_court]);
  perform expire_stale_holds(p_court);
  -- grid alignment, slot multiple and opening hours, in the club's timezone — one shared validator
  perform assert_valid_court_slot(p_club, p_court, p_start, p_end);

  v_price := quote_price(p_court, p_start, p_end);

  insert into bookings (id, club_id, court_id, player_id, guest_name, guest_phone,
                        start_at, end_at, status, source, created_by, price_usd, fee_usd)
  values (v_id, p_club, p_court, null, v_name, nullif(btrim(coalesce(p_phone, '')), ''),
          p_start, p_end, 'confirmed', 'staff', auth.uid(), v_price, 0);
  return v_id;
exception
  when exclusion_violation then raise exception 'slot_taken';
end $function$;

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
  if p_start < now() and not (p_start = b.start_at and b.end_at > now() and p_end > now()) then      -- 0071
    raise exception 'move_into_past';                                                                -- 0071
  end if;                                                                                            -- 0071
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
end $function$;
