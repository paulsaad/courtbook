-- Rollback of 0093 (pilot): the three functions exactly as before it (book_at_desk 0053, hold_slot 0065,
-- request_account_deletion 0086). Safe at any time: no data changes, grants kept.

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
  -- a missing time is not a time: without this the comparisons below are null, not false, and a
  -- reused token would hand back the earlier booking
  if p_start is null or p_end is null then raise exception 'bad_range'; end if;
  if p_end <= p_start then raise exception 'bad_range'; end if;
  if p_start <= now() then raise exception 'slot_in_past'; end if;

  select club_id into v_club from courts where id = p_court and active;
  if v_club is null then raise exception 'court_not_found'; end if;

  select * into c from clubs where id = v_club and active for share;
  if not found then raise exception 'club_not_found'; end if;
  if c.payment_mode <> 'at_desk' then raise exception 'wrong_payment_mode'; end if;
  if p_start > now() + make_interval(days => c.booking_window_days) then raise exception 'beyond_booking_window'; end if;

  v_mins := extract(epoch from (p_end - p_start)) / 60;
  if v_mins < c.min_booking_minutes or v_mins > c.max_booking_minutes then raise exception 'bad_duration'; end if;

  perform 1 from profiles where id = v_player for update;

  select * into e from bookings where player_id = v_player and client_token = p_token;
  if found then
    if e.court_id is distinct from p_court or e.start_at is distinct from p_start or e.end_at is distinct from p_end then
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
    select * into e from bookings where player_id = v_player and client_token = p_token;
    if not found then raise; end if;
    if e.court_id is distinct from p_court or e.start_at is distinct from p_start or e.end_at is distinct from p_end then
      raise exception 'token_reused';
    end if;
    return query select e.id, e.price_usd, true;
end $$;

create or replace function hold_slot(p_club uuid, p_court uuid, p_start timestamptz, p_end timestamptz, p_token uuid default null)
returns table (booking_id uuid, payment_id uuid, amount_usd numeric, fee_usd numeric, total_usd numeric,
               hold_expires_at timestamptz, already boolean)
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
  e bookings%rowtype;
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

  -- A retry of an attempt that already reached the database. The player row lock above serialises
  -- two calls with the same token, so the second always sees the first one's committed row here.
  if p_token is not null then
    select * into e from bookings where player_id = v_player and client_token = p_token;
    if found then
      if e.court_id is distinct from p_court or e.start_at <> p_start or e.end_at <> p_end then
        raise exception 'token_reused';
      end if;
      return query
        select e.id, p.id, p.amount_usd, p.fee_usd, p.total_usd, e.hold_expires_at, true
        from (select 1) one left join payments p on p.booking_id = e.id;
      return;
    end if;
  end if;

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
                        hold_expires_at, price_usd, fee_usd, client_token)
  values (v_booking, p_club, p_court, v_player, p_start, p_end, 'pending', 'app', v_player, v_exp, v_price, c.service_fee_usd, p_token);

  insert into payments (id, booking_id, profile_id, club_id, provider, amount_usd, fee_usd, total_usd)
  values (v_payment, v_booking, v_player, p_club,
          coalesce(nullif(current_setting('app.payment_provider', true), ''), 'simulated'),
          v_price, c.service_fee_usd, v_price + c.service_fee_usd);

  return query select v_booking, v_payment, v_price, c.service_fee_usd, v_price + c.service_fee_usd, v_exp, false;
exception
  when exclusion_violation then raise exception 'slot_taken';
  when unique_violation then
    -- Second line of defence for a token, as in book_at_desk. A duplicate token insert lands here and
    -- the whole call rolls back (including any holds it expired), so the retry still gets its own
    -- booking. The up-front check above is still needed: a retry whose expired slot has since been
    -- taken fails with slot_taken before reaching the insert (suite check 107u proves the difference).
    if p_token is not null then
      select * into e from bookings where player_id = v_player and client_token = p_token;
      if found then
        if e.court_id is distinct from p_court or e.start_at <> p_start or e.end_at <> p_end then
          raise exception 'token_reused';
        end if;
        return query
          select e.id, p.id, p.amount_usd, p.fee_usd, p.total_usd, e.hold_expires_at, true
          from (select 1) one left join payments p on p.booking_id = e.id;
        return;
      end if;
    end if;
    raise exception 'hold_conflict';
end $$;

create or replace function request_account_deletion(p_via text default 'app') returns jsonb
language plpgsql security definer set search_path = public as $$
declare d account_deletions%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if p_via not in ('app', 'web') then raise exception 'invalid_via'; end if;
  if exists (select 1 from profiles where id = auth.uid() and 'admin' = any(roles)) then raise exception 'admin_role'; end if;
  if exists (select 1 from club_staff where profile_id = auth.uid()) then raise exception 'staff_role'; end if;
  select * into d from account_deletions where subject_id = auth.uid() and status in ('requested', 'closing', 'closed', 'held', 'data_removed');
  if not found then
    insert into account_deletions (subject_id, requested_via) values (auth.uid(), p_via) returning * into d;
  end if;
  return jsonb_build_object('status', d.status, 'requested_at', d.requested_at);
end $$;
