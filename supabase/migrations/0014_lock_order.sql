-- Phase 2 review: one lock order everywhere — court → booking → payment.
-- Functions that start from a booking/payment id read the court id without locking, take the
-- locks in order, then re-read and validate state under the locks.
-- Also: already_paid is returned only for an identical retry (same provider_ref and amount).

-- helper: lock a set of courts in a deterministic order
create or replace function lock_courts(p_courts uuid[]) returns void
language plpgsql as $$
declare cid uuid;
begin
  for cid in select distinct c from unnest(p_courts) as c order by c loop
    perform 1 from courts where id = cid for update;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
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

  -- courts involved: the target plus any court where this player holds a pending slot
  select array_agg(court_id) || p_court into v_courts
  from bookings where player_id = v_player and status = 'pending' and court_id is not null;
  perform lock_courts(coalesce(v_courts, array[p_court]));

  -- release this player's other live holds (booking lock, then payment)
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
end $$;

-- expire_stale_holds is always called with the court already locked: lock bookings, then payments
create or replace function expire_stale_holds(p_court uuid) returns void
language plpgsql as $$
begin
  perform 1 from bookings where court_id = p_court and status = 'pending' and hold_expires_at < now() for update;
  update bookings set status = 'expired'
  where court_id = p_court and status = 'pending' and hold_expires_at < now();
  update payments p set status = 'expired'
  from bookings b
  where p.booking_id = b.id and b.court_id = p_court and b.status = 'expired' and p.status = 'pending';
end $$;

-- ---------------------------------------------------------------------------
create or replace function release_hold(p_booking uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_court uuid; b bookings%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select court_id into v_court from bookings where id = p_booking and player_id = auth.uid();
  if v_court is null then raise exception 'forbidden'; end if;
  perform 1 from courts where id = v_court for update;
  select * into b from bookings where id = p_booking for update;
  if b.status <> 'pending' then return; end if;
  update bookings set status = 'expired' where id = p_booking;
  update payments set status = 'expired' where booking_id = p_booking and status = 'pending';
end $$;

-- ---------------------------------------------------------------------------
create or replace function confirm_payment(p_payment uuid, p_provider_ref text, p_total_usd numeric)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_booking uuid;
  v_court uuid;
  p payments%rowtype;
  b bookings%rowtype;
begin
  select booking_id into v_booking from payments where id = p_payment;
  if v_booking is null then raise exception 'payment_not_found'; end if;
  select court_id into v_court from bookings where id = v_booking;

  -- lock order: court → booking → payment
  if v_court is not null then perform 1 from courts where id = v_court for update; end if;
  select * into b from bookings where id = v_booking for update;
  select * into p from payments where id = p_payment for update;

  if p.status = 'paid' then
    if p.provider_ref = p_provider_ref and p.total_usd = p_total_usd then return 'already_paid'; end if;
    raise exception 'payment_mismatch';          -- same payment, different ref/amount: investigate
  end if;
  if p.status in ('refund_due', 'refunded') then return p.status::text; end if;
  if p.total_usd <> p_total_usd then raise exception 'amount_mismatch'; end if;
  if exists (select 1 from payments where provider_ref = p_provider_ref and id <> p_payment) then
    raise exception 'duplicate_provider_ref';
  end if;

  if b.status = 'pending' then
    -- slot still exclusively held (constraint covers pending): confirm, even slightly after the
    -- deadline. A hold that another booking attempt has swept is 'expired' and falls through.
    update bookings set status = 'confirmed', hold_expires_at = null where id = b.id;
    update payments set status = 'paid', paid_at = now(), provider_ref = p_provider_ref where id = p.id;
    return 'confirmed';
  end if;

  update payments set status = 'refund_due', provider_ref = p_provider_ref, note = 'paid after hold expired or booking cancelled' where id = p.id;
  return 'refund_due';
end $$;
revoke execute on function confirm_payment(uuid, text, numeric) from public, anon, authenticated;
grant execute on function confirm_payment(uuid, text, numeric) to service_role;

create or replace function fail_payment(p_payment uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare v_booking uuid; v_court uuid; p payments%rowtype;
begin
  select booking_id into v_booking from payments where id = p_payment;
  if v_booking is null then return; end if;
  select court_id into v_court from bookings where id = v_booking;
  if v_court is not null then perform 1 from courts where id = v_court for update; end if;
  perform 1 from bookings where id = v_booking for update;
  select * into p from payments where id = p_payment for update;
  if p.status <> 'pending' then return; end if;
  update payments set status = 'failed', note = p_note where id = p.id;
  update bookings set status = 'expired' where id = v_booking and status = 'pending';
end $$;
revoke execute on function fail_payment(uuid, text) from public, anon, authenticated;
grant execute on function fail_payment(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
create or replace function cancel_booking(p_booking uuid, p_club_caused boolean default false)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_court uuid;
  b bookings%rowtype;
  cutoff int;
  is_staff boolean;
  refund boolean;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  select court_id into v_court from bookings where id = p_booking;
  if not found then raise exception 'not_found'; end if;
  if v_court is not null then perform 1 from courts where id = v_court for update; end if;
  select * into b from bookings where id = p_booking for update;
  perform 1 from payments where booking_id = p_booking for update;

  if b.status not in ('confirmed', 'pending') then raise exception 'not_confirmed'; end if;

  is_staff := is_staff_of(b.club_id);
  if not is_staff and (b.player_id is null or b.player_id <> auth.uid()) then raise exception 'forbidden'; end if;
  if p_club_caused and (not is_staff or b.player_id = auth.uid()) then raise exception 'forbidden'; end if;

  select cancel_cutoff_hours into cutoff from clubs where id = b.club_id;
  refund := p_club_caused or b.start_at - make_interval(hours => cutoff) > now();

  update bookings set status = 'cancelled', cancelled_at = now() where id = p_booking;

  if b.status = 'pending' then
    update payments set status = 'expired' where booking_id = b.id and status = 'pending';
  elsif refund then
    update payments set status = 'refund_due',
      note = case when p_club_caused then 'club-caused cancellation' else 'cancelled before cutoff' end
      where booking_id = b.id and status = 'paid';
  end if;

  if b.credit_tx_id is not null and refund then
    insert into credit_transactions (profile_id, delta, kind, booking_id, created_by)
    values (b.player_id, +1, 'refund', b.id, auth.uid());
  end if;
end $$;

-- move_booking / mark_no_show / close_club already start with the court lock (or lock it first)
create or replace function mark_no_show(p_booking uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_court uuid; b bookings%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select court_id into v_court from bookings where id = p_booking;
  if not found then raise exception 'not_found'; end if;
  if v_court is not null then perform 1 from courts where id = v_court for update; end if;
  select * into b from bookings where id = p_booking for update;
  if not is_staff_of(b.club_id) then raise exception 'forbidden'; end if;
  if b.status <> 'confirmed' then raise exception 'not_confirmed'; end if;
  if b.start_at > now() then raise exception 'not_started'; end if;
  update bookings set status = 'no_show' where id = p_booking;
end $$;

create or replace function move_booking(p_booking uuid, p_court uuid, p_start timestamptz, p_end timestamptz)
returns void
language plpgsql security definer set search_path = public as $$
declare v_court uuid; b bookings%rowtype;
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
  update bookings set court_id = p_court, start_at = p_start, end_at = p_end where id = p_booking;
exception
  when exclusion_violation then
    raise exception 'slot_taken';
end $$;
