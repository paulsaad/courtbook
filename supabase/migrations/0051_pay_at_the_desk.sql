-- Phase 10: a club can run on CourtBook while taking payment at its own desk, so a pilot does not
-- wait on merchant onboarding. Nothing moves through CourtBook for such a club, and the simulated
-- flow must be unreachable for it — not merely hidden in the app.
--
-- Two modes per club:
--   'simulated'  what every club does today: hold -> pay -> confirmed. Stays the default, so no
--                existing club changes behaviour until an admin deliberately switches it.
--   'at_desk'    reserve and it is confirmed at once. The price is recorded, the CourtBook fee is 0
--                and no payments row exists, exactly as for a walk-in the desk types in.

alter table clubs add column if not exists payment_mode text not null default 'simulated';
alter table clubs drop constraint if exists clubs_payment_mode_check;
alter table clubs add constraint clubs_payment_mode_check check (payment_mode in ('simulated', 'at_desk'));

-- how many bookings one player may hold at a club at once. Nothing is at stake when no money moves,
-- so this is the brake on a player tying up courts they may not use.
alter table clubs add column if not exists max_upcoming_bookings int not null default 3;
alter table clubs drop constraint if exists clubs_max_upcoming_check;
alter table clubs add constraint clubs_max_upcoming_check check (max_upcoming_bookings between 1 and 20);

-- a retry must not become a second court. The client sends the same token when it retries.
alter table bookings add column if not exists client_token uuid;
create unique index if not exists bookings_one_per_client_token on bookings (player_id, client_token)
  where client_token is not null;

-- Reserve, at a club that takes payment at its desk ------------------------------------------------
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
  v_existing uuid;
  n int;
begin
  if v_player is null then raise exception 'not_authenticated'; end if;
  if p_token is null then raise exception 'token_required'; end if;
  if p_start <= now() then raise exception 'slot_in_past'; end if;

  select club_id into v_club from courts where id = p_court and active;
  if v_club is null then raise exception 'court_not_found'; end if;
  select * into c from clubs where id = v_club and active;
  if not found then raise exception 'club_not_found'; end if;
  if c.payment_mode <> 'at_desk' then raise exception 'wrong_payment_mode'; end if;
  if p_start > now() + make_interval(days => c.booking_window_days) then raise exception 'beyond_booking_window'; end if;

  v_mins := extract(epoch from (p_end - p_start)) / 60;
  if v_mins < c.min_booking_minutes or v_mins > c.max_booking_minutes then raise exception 'bad_duration'; end if;

  -- lock order, as everywhere else: player → courts → bookings
  perform 1 from profiles where id = v_player for update;

  -- a retry of a request that already succeeded returns the same booking rather than a second one
  select id into v_existing from bookings where player_id = v_player and client_token = p_token;
  if v_existing is not null then
    return query select v_existing, b.price_usd, true from bookings b where b.id = v_existing;
    return;
  end if;

  perform lock_courts(array[p_court]);
  perform expire_stale_holds(p_court);
  perform assert_valid_court_slot(v_club, p_court, p_start, p_end);

  -- the cap counts only what is still ahead of them at this club: a cancelled booking, or one that
  -- has already started, frees a place
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
    -- two retries racing each other: whichever lost reads the row the winner wrote
    select id into v_existing from bookings where player_id = v_player and client_token = p_token;
    if v_existing is null then raise; end if;
    return query select v_existing, b.price_usd, true from bookings b where b.id = v_existing;
end $$;
revoke execute on function book_at_desk(uuid, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function book_at_desk(uuid, timestamptz, timestamptz, uuid) to authenticated;

-- No simulated money at an at_desk club, whatever route is used ------------------------------------
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
  -- this club settles at its own desk: there is nothing to pay for here
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

-- The last gate. Rather than rewriting confirm_payment() — which carries its own lock order,
-- duplicate-provider-ref check and late-payment leniency — the rule is enforced on the payments
-- table itself, so it holds for every path that exists now or later: the simulated route, a real
-- gateway callback, a stale link, or a direct call with service credentials.
create or replace function payments_block_at_desk() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_mode text;
begin
  -- only block making money owed or taken. A club switched to at_desk may still have to refund a
  -- payment it took before the switch, so refunded / refund_due / expired stay possible.
  if new.status not in ('pending', 'paid') then return new; end if;
  select payment_mode into v_mode from clubs where id = new.club_id;
  if v_mode = 'at_desk' then raise exception 'wrong_payment_mode'; end if;
  return new;
end $$;

drop trigger if exists payments_no_money_at_desk on payments;
create trigger payments_no_money_at_desk
  before insert or update of status on payments
  for each row execute function payments_block_at_desk();

-- Switching a club's mode --------------------------------------------------------------------------
-- Admin only in this phase. Switching to at_desk leaves no half-finished payment behind: every live
-- hold at that club is expired, with its payment, in the same transaction as the switch. Players lose
-- a hold they could no longer have paid for, which is the honest outcome.
create or replace function set_club_payment_mode(p_club uuid, p_mode text) returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not is_admin() then raise exception 'forbidden'; end if;
  if p_mode not in ('simulated', 'at_desk') then raise exception 'bad_payment_mode'; end if;
  perform 1 from clubs where id = p_club for update;
  if not found then raise exception 'club_not_found'; end if;

  -- expire the holds BEFORE the club flips, or the trigger below would refuse to expire their payments
  if p_mode = 'at_desk' then
    update bookings set status = 'expired'
    where club_id = p_club and status = 'pending';
    get diagnostics n = row_count;
    update payments p set status = 'expired'
    from bookings b where p.booking_id = b.id and b.club_id = p_club and b.status = 'expired' and p.status = 'pending';
  end if;

  update clubs set payment_mode = p_mode where id = p_club;
  return n;   -- holds released by the switch
end $$;
revoke execute on function set_club_payment_mode(uuid, text) from public, anon;
grant execute on function set_club_payment_mode(uuid, text) to authenticated;
