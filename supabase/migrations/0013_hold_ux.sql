-- Phase 2 phone test fixes.
-- (a) Expired holds are invisible immediately (occupancy) and swept by any booking or block
--     attempt on that court, not only by hold_slot.
-- (b) A new hold replaces the player's previous live hold instead of failing.

create or replace function expire_stale_holds(p_court uuid) returns void
language plpgsql as $$
begin
  update payments p set status = 'expired'
  from bookings b
  where p.booking_id = b.id and b.court_id = p_court and b.status = 'pending'
    and b.hold_expires_at < now() and p.status = 'pending';
  update bookings set status = 'expired'
  where court_id = p_court and status = 'pending' and hold_expires_at < now();
end $$;

-- booking insert/move: lock court, sweep, then the block check (exclusion constraint runs after)
create or replace function reject_booking_over_block() returns trigger
language plpgsql as $$
begin
  if new.court_id is null or new.status not in ('confirmed', 'pending') then
    return new;
  end if;
  perform 1 from courts where id = new.court_id for update;
  perform expire_stale_holds(new.court_id);
  if exists (
    select 1 from blocks b
    where b.court_id = new.court_id and b.period && tstzrange(new.start_at, new.end_at, '[)')
  ) then
    raise exception 'slot_blocked' using errcode = '23P01';
  end if;
  return new;
end $$;

create or replace function reject_block_over_booking() returns trigger
language plpgsql as $$
begin
  perform 1 from courts where id = new.court_id for update;
  perform expire_stale_holds(new.court_id);
  if exists (
    select 1 from bookings k
    where k.court_id = new.court_id and k.status in ('confirmed', 'pending')
      and k.period && tstzrange(new.start_at, new.end_at, '[)')
  ) then
    raise exception 'block_overlaps_booking' using errcode = '23P01';
  end if;
  return new;
end $$;

drop view occupancy;
create view occupancy with (security_invoker = false) as
  select case when player_id = auth.uid() then id end as id,
         club_id, court_id, coach_id, start_at, end_at, status,
         (player_id = auth.uid()) as mine,
         'booking'::text as kind
  from bookings
  where status = 'confirmed' or (status = 'pending' and hold_expires_at > now())
  union all
  select null::uuid, club_id, court_id, null::uuid, start_at, end_at, 'confirmed'::booking_status, false, 'block'::text
  from blocks;
revoke all on occupancy from public, anon;
grant select on occupancy to authenticated;

-- hold_slot: replace the player's live hold instead of refusing
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

  -- release this player's other live holds (they picked something else)
  update payments p set status = 'expired'
  from bookings b
  where p.booking_id = b.id and b.player_id = v_player and b.status = 'pending' and p.status = 'pending';
  update bookings set status = 'expired' where player_id = v_player and status = 'pending';

  perform 1 from courts where id = p_court for update;
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

-- the player's current live hold, for the "continue to payment" banner
create or replace function my_active_hold()
returns table (booking_id uuid, court_name text, start_at timestamptz, end_at timestamptz, hold_expires_at timestamptz, club_slug text)
language sql stable security definer set search_path = public as $$
  select b.id, k.name, b.start_at, b.end_at, b.hold_expires_at, c.slug
  from bookings b join courts k on k.id = b.court_id join clubs c on c.id = b.club_id
  where b.player_id = auth.uid() and b.status = 'pending' and b.hold_expires_at > now()
  order by b.created_at desc limit 1;
$$;
revoke execute on function my_active_hold() from public, anon;
grant execute on function my_active_hold() to authenticated;
