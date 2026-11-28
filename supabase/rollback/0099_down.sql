-- Rollback of 0099 (supabase/migrations/0099_staff_moves_check_what_desk_saw.sql): the two move functions exactly as
-- 0091 left them, and the function that compares what the desk saw removed. Rows are untouched either way.
-- Afterwards moves are again applied without the comparison (the F1 defect returns); the website must be one that
-- still falls back to the 0091 call (see docs/staff-moves/README.md).
drop function if exists move_booking_priced(uuid, uuid, timestamptz, timestamptz, numeric, uuid, timestamptz, timestamptz);

create or replace function move_booking_priced(p_booking uuid, p_court uuid, p_start timestamptz, p_end timestamptz, p_expected_price numeric)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_court uuid; b bookings%rowtype; c clubs%rowtype; plan record;
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
  if b.end_at <= now() then raise exception 'booking_ended'; end if;                                -- 0071
  if p_start < now() and not (p_start = b.start_at and p_end > now()) then                           -- 0071
    raise exception 'move_into_past';                                                                -- 0071
  end if;                                                                                            -- 0071
  if not exists (select 1 from courts where id = p_court and club_id = b.club_id and active) then
    raise exception 'court_not_found';
  end if;
  select * into c from clubs where id = b.club_id;
  if (p_end - p_start) <> (b.end_at - b.start_at)
     and (p_end - p_start) not between make_interval(mins => c.min_booking_minutes) and make_interval(mins => c.max_booking_minutes) then
    raise exception 'bad_duration';
  end if;
  select * into plan from move_price_plan(b, p_court, p_start, p_end);
  if plan.kind = 'refused' then raise exception 'paid_length_change'; end if;
  if p_expected_price is null then
    if plan.new_price is distinct from b.price_usd then raise exception 'price_confirmation_needed'; end if;
  elsif plan.new_price is distinct from p_expected_price then
    raise exception 'price_changed';
  end if;
  update bookings set court_id = p_court, start_at = p_start, end_at = p_end, price_usd = plan.new_price where id = p_booking;
  return jsonb_build_object('price', plan.new_price, 'kind', plan.kind);
exception
  when exclusion_violation then
    raise exception 'slot_taken';
end $$;
revoke all on function move_booking_priced(uuid, uuid, timestamptz, timestamptz, numeric) from public, anon;
grant execute on function move_booking_priced(uuid, uuid, timestamptz, timestamptz, numeric) to authenticated;

-- the older call: only moves that keep the price
create or replace function public.move_booking(p_booking uuid, p_court uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  perform move_booking_priced(p_booking, p_court, p_start, p_end, null);
end $function$;
