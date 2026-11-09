-- Phase 2 review: two simultaneous hold_slot() calls by the same player on different courts
-- could both succeed. Serialize per player (profiles row lock, taken before any court lock)
-- and enforce one pending hold per player with a partial unique index.

create unique index if not exists one_pending_hold_per_player
  on bookings (player_id) where (status = 'pending' and player_id is not null);

create or replace function hold_slot(p_club uuid, p_court uuid, p_start timestamptz, p_end timestamptz)
returns table (booking_id uuid, payment_id uuid, amount_usd numeric, fee_usd numeric, total_usd numeric, hold_expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_player uuid := auth.uid();
  c clubs%rowtype;
  v_mins numeric;
  v_price numeric;
  v_booking uuid := gen_random_uuid();
  v_payment uuid := gen_random_uuid();
  v_exp timestamptz;
  v_courts uuid[];
begin
  if v_player is null then raise exception 'not_authenticated'; end if;
  if p_start <= now() then raise exception 'slot_in_past'; end if;

  select * into c from clubs where id = p_club and active;
  if not found then raise exception 'club_not_found'; end if;
  if p_start > now() + make_interval(days => c.booking_window_days) then raise exception 'beyond_booking_window'; end if;
  if not exists (select 1 from courts where id = p_court and club_id = p_club and active) then raise exception 'court_not_found'; end if;

  v_mins := extract(epoch from (p_end - p_start)) / 60;
  if v_mins < c.min_booking_minutes or v_mins > c.max_booking_minutes or v_mins % c.slot_minutes <> 0 then
    raise exception 'bad_duration';
  end if;

  -- lock order: player → courts (id order) → bookings → payments
  perform 1 from profiles where id = v_player for update;

  select array_agg(court_id) || p_court into v_courts
  from bookings where player_id = v_player and status = 'pending' and court_id is not null;
  perform lock_courts(coalesce(v_courts, array[p_court]));

  perform 1 from bookings where player_id = v_player and status = 'pending' for update;
  update bookings set status = 'expired' where player_id = v_player and status = 'pending';
  update payments p set status = 'expired'
  from bookings b where p.booking_id = b.id and b.player_id = v_player and b.status = 'expired' and p.status = 'pending';

  perform expire_stale_holds(p_court);
  perform assert_valid_court_slot(p_club, p_court, p_start, p_end);
  v_price := quote_price(p_court, p_start, p_end);
  v_exp := now() + make_interval(mins => c.hold_minutes);

  insert into bookings (id, club_id, court_id, player_id, start_at, end_at, status, source, created_by,
                        hold_expires_at, price_usd, fee_usd)
  values (v_booking, p_club, p_court, v_player, p_start, p_end, 'pending', 'app', v_player, v_exp, v_price, c.service_fee_usd);

  insert into payments (id, booking_id, profile_id, club_id, provider, amount_usd, fee_usd, total_usd)
  values (v_payment, v_booking, v_player, p_club,
          coalesce(nullif(current_setting('app.payment_provider', true), ''), 'simulated'),
          v_price, c.service_fee_usd, v_price + c.service_fee_usd);

  return query select v_booking, v_payment, v_price, c.service_fee_usd, v_price + c.service_fee_usd, v_exp;
exception
  when exclusion_violation then
    raise exception 'slot_taken';
  when unique_violation then
    raise exception 'hold_conflict';   -- one_pending_hold_per_player: cannot happen under the profile lock
end $$;
