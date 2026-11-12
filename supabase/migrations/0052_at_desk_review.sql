-- Review of 0051, three findings, all valid.
--
-- 1. A token reused with different details silently returned the first booking, so a player who
--    changed the date and retried got their old slot back and believed they had the new one.
-- 2. A stale confirm_payment() for an expired payment at a club that now settles at its desk
--    returned 'refund_due' — inventing money owed at a club that never took any. The trigger only
--    blocked 'paid'.
-- 3. The mode was read without holding the club row, so a request could validate against the old
--    mode and then wait elsewhere while the mode changed under it.
--
-- Lock order is now club → player → courts → bookings → payments, everywhere money or a slot moves.

-- 1 + 3 -------------------------------------------------------------------------------------------
create or replace function book_at_desk(p_court uuid, p_start timestamptz, p_end timestamptz, p_token uuid)
returns table (booking_id uuid, price_usd numeric, already boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_player uuid := auth.uid();
  c clubs%rowtype;
  v_club uuid;
  v_mins numeric;
  v_price numeric;
  v_id uuid := gen_random_uuid();
  e bookings%rowtype;
  n int;
begin
  if v_player is null then raise exception 'not_authenticated'; end if;
  if p_token is null then raise exception 'token_required'; end if;
  if p_start <= now() then raise exception 'slot_in_past'; end if;

  select club_id into v_club from courts where id = p_court and active;
  if v_club is null then raise exception 'court_not_found'; end if;

  -- hold the club row for the whole transaction: the mode cannot change under us after this point,
  -- and a switch cannot start until we are done
  select * into c from clubs where id = v_club and active for share;
  if not found then raise exception 'club_not_found'; end if;
  if c.payment_mode <> 'at_desk' then raise exception 'wrong_payment_mode'; end if;
  if p_start > now() + make_interval(days => c.booking_window_days) then raise exception 'beyond_booking_window'; end if;

  v_mins := extract(epoch from (p_end - p_start)) / 60;
  if v_mins < c.min_booking_minutes or v_mins > c.max_booking_minutes then raise exception 'bad_duration'; end if;

  perform 1 from profiles where id = v_player for update;

  -- a retry returns the same booking only when it is a retry of the same thing. Different court or
  -- different times with the same token is a mistake, not a retry, and saying so is better than
  -- handing back a booking for a slot the player is no longer asking for.
  select * into e from bookings where player_id = v_player and client_token = p_token;
  if found then
    if e.court_id is distinct from p_court or e.start_at <> p_start or e.end_at <> p_end then
      raise exception 'token_reused';
    end if;
    return query select e.id, e.price_usd, true;
    return;
  end if;

  perform lock_courts(array[p_court]);
  perform expire_stale_holds(p_court);
  perform assert_valid_court_slot(v_club, p_court, p_start, p_end);

  select count(*) into n from bookings
  where player_id = v_player and club_id = v_club and status = 'confirmed' and start_at > now();
  if n >= c.max_upcoming_bookings then raise exception 'too_many_upcoming'; end if;

  v_price := quote_price(p_court, p_start, p_end);

  insert into bookings (id, club_id, court_id, player_id, start_at, end_at, status, source, created_by,
                        price_usd, fee_usd, client_token)
  values (v_id, v_club, p_court, v_player, p_start, p_end, 'confirmed', 'app', v_player, v_price, 0, p_token);

  return query select v_id, v_price, false;
exception
  when exclusion_violation then raise exception 'slot_taken';
  when unique_violation then
    -- two retries of the same request racing each other: the loser reads what the winner wrote,
    -- and the same mismatch rule applies to it
    select * into e from bookings where player_id = v_player and client_token = p_token;
    if not found then raise; end if;
    if e.court_id is distinct from p_court or e.start_at <> p_start or e.end_at <> p_end then
      raise exception 'token_reused';
    end if;
    return query select e.id, e.price_usd, true;
end $$;
revoke execute on function book_at_desk(uuid, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function book_at_desk(uuid, timestamptz, timestamptz, uuid) to authenticated;

-- 3, for the in-app flow as well
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

  -- club first, and held: the mode cannot flip while this hold is being created
  select * into c from clubs where id = p_club and active for share;
  if not found then raise exception 'club_not_found'; end if;
  if c.payment_mode = 'at_desk' then raise exception 'wrong_payment_mode'; end if;
  if p_start > now() + make_interval(days => c.booking_window_days) then raise exception 'beyond_booking_window'; end if;
  if not exists (select 1 from courts where id = p_court and club_id = p_club and active) then raise exception 'court_not_found'; end if;

  v_mins := extract(epoch from (p_end - p_start)) / 60;
  if v_mins < c.min_booking_minutes or v_mins > c.max_booking_minutes or v_mins % c.slot_minutes <> 0 then
    raise exception 'bad_duration';
  end if;

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
  when exclusion_violation then raise exception 'slot_taken';
  when unique_violation then raise exception 'hold_conflict';
end $$;
revoke execute on function hold_slot(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function hold_slot(uuid, uuid, timestamptz, timestamptz) to authenticated;

-- 2 + 3 -------------------------------------------------------------------------------------------
-- A refund is legitimate only for money that was actually taken. Anything else that would leave a
-- desk-mode club owing money — including confirm_payment() landing late on an expired hold and
-- marking it refund_due — is refused. The club row is read under a share lock so the mode cannot
-- change between this check and the write.
create or replace function payments_block_at_desk() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_mode text; v_was_paid boolean;
begin
  v_was_paid := tg_op = 'UPDATE' and old.status = 'paid';
  -- states that neither owe nor take money are always fine
  if new.status not in ('pending', 'paid', 'refund_due', 'refunded') then return new; end if;
  -- refunding money actually collected stays possible after a club switches
  if new.status in ('refund_due', 'refunded') and v_was_paid then return new; end if;
  select payment_mode into v_mode from clubs where id = new.club_id for share;
  if v_mode = 'at_desk' then raise exception 'wrong_payment_mode'; end if;
  return new;
end $$;

drop trigger if exists payments_no_money_at_desk on payments;
create trigger payments_no_money_at_desk
  before insert or update of status on payments
  for each row execute function payments_block_at_desk();
