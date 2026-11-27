-- DRAFT (F1, Paul's decision of 26 Nov): a staff move is applied only if the booking is still where the desk saw it.
-- NOT a numbered migration. NOT applied anywhere. Not part of the 0087–0093 staging sequence. Applying it needs its own
-- number, the read-only preflight (supabase/live/staff_moves_preflight.sql), the postcheck and Paul's authorization.
--
-- The defect: two desks open the same booking (Padel 2, 18:00). Desk A moves it to Padel 1. Desk B, whose screen still
-- says Padel 2, moves it to Padel 3. Both calls succeed; the last one silently wins and desk A's move is lost.
--
-- The rule: the caller sends what it saw (court, start, end, as its screen showed them when the booking was opened).
-- After the booking row is locked (select … for update), the database compares the row with those values and refuses
-- with 'booking_changed_elsewhere' if any differ. The comparison and the update happen under the same row lock, so no
-- other session can change the row in between (a client-side re-read could not guarantee that).
--
--   move_booking_priced(booking, court, start, end, expected_price, seen_court, seen_start, seen_end)   NEW
--     Exactly 0091's function plus the comparison (lines marked "-- F1"). The checks keep their order: not signed in,
--     not found, forbidden (staff of another club learn nothing about the booking), not active, not a court booking,
--     then the comparison, then everything else (range, past, court, length, price, slot taken).
--     A missing (null) seen value never matches: the move is refused.
--   move_booking_priced(booking, court, start, end, expected_price)                                   0091 → REFUSES
--   move_booking(booking, court, start, end)                                                           0091 → REFUSES
--     Kept only so that a page opened before the new website gets an answer instead of "function not found". Both
--     refuse every call with 'move_needs_reload' (a page shows its generic "Something went wrong. Refresh and try
--     again.", which is the right advice; the website reports it as unexpected). Nothing can move a booking without
--     the comparison any more. Execute rights are unchanged (signed-in users), so the answer stays readable.
--
-- What is compared: court_id, start_at, end_at — exactly what a move changes. If another desk moves a booking away and
-- back again, the booking is where this desk saw it and the move applies; that is correct (nothing this desk saw is
-- out of date). Status is checked before the comparison ('not_confirmed'), as in 0091.
--
-- Unchanged: quote_move, move_price_plan, lock_courts, cancellation, booking, every other function and every row.
-- Direct UPDATE of bookings by signed-in users stays impossible (no update policy since 0002), so the functions are
-- the only way to move a booking.
-- Rebuilt from 0091's text (the 0063 rule). Safe to re-run.

create or replace function move_booking_priced(p_booking uuid, p_court uuid, p_start timestamptz, p_end timestamptz, p_expected_price numeric,
  p_seen_court uuid, p_seen_start timestamptz, p_seen_end timestamptz)
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
  if b.court_id is distinct from p_seen_court                                                        -- F1
     or b.start_at is distinct from p_seen_start                                                     -- F1
     or b.end_at is distinct from p_seen_end then                                                    -- F1
    raise exception 'booking_changed_elsewhere';                                                     -- F1
  end if;                                                                                            -- F1
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
revoke all on function move_booking_priced(uuid, uuid, timestamptz, timestamptz, numeric, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function move_booking_priced(uuid, uuid, timestamptz, timestamptz, numeric, uuid, timestamptz, timestamptz) to authenticated;

-- the calls without what the desk saw: refused (an open page from before the change gets an answer)
create or replace function move_booking_priced(p_booking uuid, p_court uuid, p_start timestamptz, p_end timestamptz, p_expected_price numeric)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  raise exception 'move_needs_reload';
end $$;
revoke all on function move_booking_priced(uuid, uuid, timestamptz, timestamptz, numeric) from public, anon;
grant execute on function move_booking_priced(uuid, uuid, timestamptz, timestamptz, numeric) to authenticated;

create or replace function public.move_booking(p_booking uuid, p_court uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  raise exception 'move_needs_reload';
end $function$;
