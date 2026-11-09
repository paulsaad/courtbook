-- Phase 2: player pays court price + platform fee in the app. Replaces credits for players.
-- Flow: hold_slot() → pending booking + payment row (slot blocked for hold_minutes)
--       server confirms via confirm_payment() (service role only) → confirmed
--       cancel_booking() → refund rules (before cutoff / club-caused)
-- Rules (review): holds block overlaps; hold/expiry/confirm serialized per court; confirmation
-- idempotent; an expired hold never confirms; price frozen at hold time.

-- ---------------------------------------------------------------------------
-- Club settings
-- ---------------------------------------------------------------------------
alter table clubs add column service_fee_usd numeric(6,2) not null default 1.00 check (service_fee_usd >= 0);
alter table clubs add column hold_minutes int not null default 10 check (hold_minutes between 2 and 30);
alter table clubs alter column cancel_cutoff_hours set default 6;

-- ---------------------------------------------------------------------------
-- Bookings: hold + frozen price
-- ---------------------------------------------------------------------------
alter table bookings add column hold_expires_at timestamptz;
alter table bookings add column price_usd numeric(8,2);     -- court price, frozen at hold
alter table bookings add column fee_usd   numeric(6,2);     -- platform fee, frozen at hold
alter table bookings add column currency  text not null default 'USD';

create type payment_status as enum ('pending', 'paid', 'failed', 'expired', 'refund_due', 'refunded');

create table payments (
  id            uuid primary key default gen_random_uuid(),
  booking_id    uuid not null unique references bookings(id),
  profile_id    uuid not null references profiles(id),
  club_id       uuid not null references clubs(id),
  provider      text not null check (provider in ('simulated', 'whish', 'areeba')),
  provider_ref  text unique,                       -- gateway transaction id; set on confirm
  amount_usd    numeric(8,2) not null,             -- court price
  fee_usd       numeric(6,2) not null,             -- platform fee
  total_usd     numeric(8,2) not null,
  currency      text not null default 'USD',
  status        payment_status not null default 'pending',
  created_at    timestamptz not null default now(),
  paid_at       timestamptz,
  refunded_at   timestamptz,
  note          text
);
create index payments_profile_idx on payments (profile_id, created_at desc);
create index payments_club_idx on payments (club_id, created_at desc);

alter table payments enable row level security;
create policy "payments: read own or club staff" on payments for select
  using (profile_id = auth.uid() or is_staff_of(club_id));
-- no insert/update policies: only the functions below write payments

-- ---------------------------------------------------------------------------
-- Occupancy: pending holds occupy the slot like confirmed bookings
-- ---------------------------------------------------------------------------
alter table bookings drop constraint no_double_booking_court;
alter table bookings add constraint no_double_booking_court
  exclude using gist (court_id with =, period with &&)
  where (status in ('confirmed', 'pending') and court_id is not null);

alter table bookings drop constraint no_double_booking_coach;
alter table bookings add constraint no_double_booking_coach
  exclude using gist (coach_id with =, period with &&)
  where (status in ('confirmed', 'pending') and coach_id is not null);

drop index if exists bookings_court_start_idx;
create index bookings_court_start_idx on bookings (court_id, start_at) where status in ('confirmed', 'pending');

create or replace function reject_booking_over_block() returns trigger
language plpgsql as $$
begin
  if new.court_id is null or new.status not in ('confirmed', 'pending') then
    return new;
  end if;
  perform 1 from courts where id = new.court_id for update;
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
  if exists (
    select 1 from bookings k
    where k.court_id = new.court_id and k.status in ('confirmed', 'pending')
      and k.period && tstzrange(new.start_at, new.end_at, '[)')
  ) then
    raise exception 'block_overlaps_booking' using errcode = '23P01';
  end if;
  return new;
end $$;

create or replace function bookings_validate_slot() returns trigger
language plpgsql as $$
begin
  if new.court_id is not null and new.status in ('confirmed', 'pending') then
    perform assert_valid_court_slot(new.club_id, new.court_id, new.start_at, new.end_at);
  end if;
  return new;
end $$;

drop view occupancy;
create view occupancy with (security_invoker = false) as
  select case when player_id = auth.uid() then id end as id,
         club_id, court_id, coach_id, start_at, end_at, status,
         (player_id = auth.uid()) as mine,
         'booking'::text as kind
  from bookings where status in ('confirmed', 'pending')
  union all
  select null::uuid, club_id, court_id, null::uuid, start_at, end_at, 'confirmed'::booking_status, false, 'block'::text
  from blocks;
revoke all on occupancy from public, anon;
grant select on occupancy to authenticated;

-- ---------------------------------------------------------------------------
-- Price quote: sum of the applicable hourly rule over each grid step
-- ---------------------------------------------------------------------------
create or replace function quote_price(p_court uuid, p_start timestamptz, p_end timestamptz)
returns numeric
language plpgsql stable security definer set search_path = public as $$
declare
  c clubs%rowtype;
  v_court courts%rowtype;
  t timestamptz := p_start;
  total numeric := 0;
  step_price numeric;
  l_time time;
  l_dow int;   -- 0 = Monday
begin
  select * into v_court from courts where id = p_court;
  if not found then raise exception 'court_not_found'; end if;
  select * into c from clubs where id = v_court.club_id;

  while t < p_end loop
    l_time := (t at time zone c.timezone)::time;
    l_dow  := extract(isodow from (t at time zone c.timezone))::int - 1;
    select pr.price_usd into step_price
    from price_rules pr
    where pr.club_id = c.id
      and (pr.court_id = p_court or pr.court_id is null)
      and (pr.weekday_mask & (1 << l_dow)) <> 0
      and pr.start_time <= l_time and l_time < pr.end_time
    order by pr.court_id nulls last           -- court-specific rule wins
    limit 1;
    if step_price is null then raise exception 'no_price_rule'; end if;
    total := total + step_price * c.slot_minutes / 60.0;
    t := t + make_interval(mins => c.slot_minutes);
  end loop;
  return round(total, 2);
end $$;
revoke execute on function quote_price(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function quote_price(uuid, timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- hold_slot: pending booking + payment, price frozen, serialized per court
-- ---------------------------------------------------------------------------
drop function if exists book_slot(uuid, uuid, uuid, timestamptz, timestamptz);

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

  -- serialize everything on this court: expire stale holds, then insert
  perform 1 from courts where id = p_court for update;
  update payments p set status = 'expired'
  from bookings b
  where p.booking_id = b.id and b.court_id = p_court and b.status = 'pending' and b.hold_expires_at < now()
    and p.status = 'pending';
  update bookings set status = 'expired' where court_id = p_court and status = 'pending' and hold_expires_at < now();

  -- one live hold per player
  if exists (select 1 from bookings where player_id = v_player and status = 'pending' and hold_expires_at >= now()) then
    raise exception 'hold_already_active';
  end if;

  perform assert_valid_court_slot(p_club, p_court, p_start, p_end);   -- clear error before pricing
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
revoke execute on function hold_slot(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function hold_slot(uuid, uuid, timestamptz, timestamptz) to authenticated;

-- Player gives up before paying (frees the slot immediately)
create or replace function release_hold(p_booking uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b bookings%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into b from bookings where id = p_booking for update;
  if not found or b.player_id <> auth.uid() then raise exception 'forbidden'; end if;
  if b.status <> 'pending' then return; end if;
  update bookings set status = 'expired' where id = p_booking;
  update payments set status = 'expired' where booking_id = p_booking and status = 'pending';
end $$;
revoke execute on function release_hold(uuid) from public, anon;
grant execute on function release_hold(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- confirm_payment: SERVICE ROLE ONLY (called by the server after the provider confirms).
-- Idempotent on payment id and on provider_ref. Never confirms an expired hold.
-- ---------------------------------------------------------------------------
create or replace function confirm_payment(p_payment uuid, p_provider_ref text, p_total_usd numeric)
returns text
language plpgsql security definer set search_path = public as $$
declare
  p payments%rowtype;
  b bookings%rowtype;
begin
  select * into p from payments where id = p_payment for update;
  if not found then raise exception 'payment_not_found'; end if;
  if p.status = 'paid' then return 'already_paid'; end if;          -- idempotent
  if p.status in ('refund_due', 'refunded') then return p.status::text; end if;
  if p.total_usd <> p_total_usd then raise exception 'amount_mismatch'; end if;
  if exists (select 1 from payments where provider_ref = p_provider_ref and id <> p_payment) then
    raise exception 'duplicate_provider_ref';
  end if;

  select * into b from bookings where id = p.booking_id for update;
  perform 1 from courts where id = b.court_id for update;          -- same lock order as hold_slot

  if b.status = 'pending' then
    -- still holding the slot (even if hold_expires_at passed: nobody else could have taken it)
    update bookings set status = 'confirmed', hold_expires_at = null where id = b.id;
    update payments set status = 'paid', paid_at = now(), provider_ref = p_provider_ref where id = p.id;
    return 'confirmed';
  end if;

  -- hold was expired (by another booking attempt) or cancelled: money arrived late
  update payments set status = 'refund_due', provider_ref = p_provider_ref, note = 'paid after hold expired' where id = p.id;
  return 'refund_due';
end $$;
revoke execute on function confirm_payment(uuid, text, numeric) from public, anon, authenticated;
grant execute on function confirm_payment(uuid, text, numeric) to service_role;

-- Provider reported failure (service role)
create or replace function fail_payment(p_payment uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare p payments%rowtype;
begin
  select * into p from payments where id = p_payment for update;
  if not found or p.status <> 'pending' then return; end if;
  update payments set status = 'failed', note = p_note where id = p.id;
  update bookings set status = 'expired' where id = p.booking_id and status = 'pending';
end $$;
revoke execute on function fail_payment(uuid, text) from public, anon, authenticated;
grant execute on function fail_payment(uuid, text) to service_role;

-- Admin/service marks a refund as executed at the provider
create or replace function mark_refunded(p_payment uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not is_admin() then raise exception 'forbidden'; end if;
  update payments set status = 'refunded', refunded_at = now() where id = p_payment and status = 'refund_due';
end $$;
revoke execute on function mark_refunded(uuid) from public, anon;
grant execute on function mark_refunded(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- cancel_booking under the payment model
--   before cutoff, or club-caused by staff: full refund (payment → refund_due)
--   after cutoff: no refund
-- ---------------------------------------------------------------------------
create or replace function cancel_booking(p_booking uuid, p_club_caused boolean default false)
returns void
language plpgsql security definer set search_path = public as $$
declare
  b bookings%rowtype;
  cutoff int;
  is_staff boolean;
  refund boolean;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  select * into b from bookings where id = p_booking for update;
  if not found then raise exception 'not_found'; end if;
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

  -- legacy credit bookings (pre-payments model)
  if b.credit_tx_id is not null and refund then
    insert into credit_transactions (profile_id, delta, kind, booking_id, created_by)
    values (b.player_id, +1, 'refund', b.id, auth.uid());
  end if;
end $$;

-- Demo club: $1 fee, 6 h cutoff
update clubs set service_fee_usd = 1.00, cancel_cutoff_hours = 6 where slug = 'batroun';
