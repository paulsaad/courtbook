-- 0091 — Moving a booking: the price follows the club's rules and is confirmed first (staff operations, 24 Nov).
--
-- The defect: move_booking changed a booking's court, time or length but never its price. A walk-in booked at the
-- desk for 1 h ($20) and stretched to 2 h, or moved into peak hours, kept $20. The calendar then told the desk to
-- collect $20.
--
-- The rules (review of 24 Nov: the price is the database's, and a changed price is shown and confirmed first):
--   * Desk walk-in (source 'staff'; no CourtBook money): the price is the club's price for the new court, time and
--     length (quote_price, as staff_book does).
--   * App booking with a CourtBook payment row (paid, still paying, or owed back): the amount is never changed.
--     Moving it (same length) keeps its price. Changing its LENGTH is refused ('paid_length_change'): the amount
--     taken would no longer match.
--   * App booking at a club that takes payment at its desk (no payment row): the same length keeps the price the
--     player saw. A new length is priced by the club's rules, and the player must agree to the new amount. The
--     staff screen asks for that; the database requires the exact new amount to be sent back.
--
-- Interfaces:
--   quote_move(booking, court, start, end) → {current, new, kind}; staff only, changes nothing. kind is one of:
--     'same'      no change of price;
--     'reprice'   a walk-in's new price;
--     'agreement' an app booking's new price that needs the player's agreement;
--     'refused'   a paid booking's length change.
--   move_booking_priced(booking, court, start, end, expected_price) moves and sets the price, all under the court
--     locks. It refuses 'price_changed' unless expected_price equals the price it computes then. Prices can change
--     between the quote and the move.
--   move_booking(booking, court, start, end), the older call, still works when the price does not change. A move
--     that would change it is refused with 'price_confirmation_needed', so no older screen can change a price
--     without showing it.
--
-- Rebuilt from pg_get_functiondef of a 0001–0090 database (the 0063 rule). Safe to re-run.

-- what a move would do to the price (internal; called with the booking row already read)
create or replace function move_price_plan(b bookings, p_court uuid, p_start timestamptz, p_end timestamptz,
  out current_price numeric, out new_price numeric, out kind text)
language plpgsql stable set search_path = public as $$
declare v_len_changed boolean := (p_end - p_start) <> (b.end_at - b.start_at);
begin
  current_price := b.price_usd;
  if b.source = 'staff' then
    new_price := quote_price(p_court, p_start, p_end);
    kind := case when new_price = b.price_usd then 'same' else 'reprice' end;
  elsif exists (select 1 from payments where booking_id = b.id) then
    new_price := b.price_usd;
    kind := case when v_len_changed then 'refused' else 'same' end;
  elsif v_len_changed then
    new_price := quote_price(p_court, p_start, p_end);
    kind := case when new_price = b.price_usd then 'same' else 'agreement' end;
  else
    new_price := b.price_usd;
    kind := 'same';
  end if;
end $$;
revoke all on function move_price_plan(bookings, uuid, timestamptz, timestamptz) from public, anon, authenticated;

create or replace function quote_move(p_booking uuid, p_court uuid, p_start timestamptz, p_end timestamptz)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare b bookings%rowtype; plan record;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into b from bookings where id = p_booking;
  if not found then raise exception 'not_found'; end if;
  if not is_staff_of(b.club_id) then raise exception 'forbidden'; end if;
  if not exists (select 1 from courts where id = p_court and club_id = b.club_id and active) then raise exception 'court_not_found'; end if;
  if p_start >= p_end then raise exception 'bad_range'; end if;
  select * into plan from move_price_plan(b, p_court, p_start, p_end);
  return jsonb_build_object('current', plan.current_price, 'new', plan.new_price, 'kind', plan.kind);
end $$;
revoke all on function quote_move(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function quote_move(uuid, uuid, timestamptz, timestamptz) to authenticated;

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
