-- Second review of the at-the-desk work. Three findings, all valid.
--
-- 1. My "was it paid" test looked only at the status it was coming from, so paid -> refund_due
--    passed and refund_due -> refunded did not: a refund could be started and never finished.
--    paid_at is the durable evidence that money was collected; it survives the whole lifecycle.
-- 2. confirm_payment() locked court -> booking -> payment and only then met the club lock inside the
--    trigger, while a mode switch holds the club and reaches for those same bookings. That is a
--    deadlock cycle. The club lock moves to the front, as in every other money path.
-- 3. A null start or end made the retry comparison null rather than false, so a token reused with
--    missing timestamps returned the earlier booking.

-- 1 -------------------------------------------------------------------------------------------
create or replace function payments_block_at_desk() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_mode text; v_collected boolean;
begin
  -- states that neither owe nor take money are always fine
  if new.status not in ('pending', 'paid', 'refund_due', 'refunded') then return new; end if;
  -- money actually collected can always be given back, however many steps the refund takes:
  -- paid_at is set when it was taken and is never cleared
  v_collected := coalesce(new.paid_at, case when tg_op = 'UPDATE' then old.paid_at end) is not null;
  if new.status in ('refund_due', 'refunded') and v_collected then return new; end if;
  select payment_mode into v_mode from clubs where id = new.club_id for share;
  if v_mode = 'at_desk' then raise exception 'wrong_payment_mode'; end if;
  return new;
end $$;

drop trigger if exists payments_no_money_at_desk on payments;
create trigger payments_no_money_at_desk
  before insert or update of status on payments
  for each row execute function payments_block_at_desk();

-- 2 -------------------------------------------------------------------------------------------
-- Unchanged except for the first two statements: the club is locked before the court, so the order
-- is club -> court -> booking -> payment everywhere, and a mode switch can no longer wait on a
-- booking this transaction holds while this transaction waits on the club.
create or replace function confirm_payment(p_payment uuid, p_provider_ref text, p_total_usd numeric)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_booking uuid;
  v_court uuid;
  v_club uuid;
  p payments%rowtype;
  b bookings%rowtype;
begin
  select booking_id, club_id into v_booking, v_club from payments where id = p_payment;
  if v_booking is null then raise exception 'payment_not_found'; end if;
  -- club first: same order as hold_slot, book_at_desk and the trigger below
  perform 1 from clubs where id = v_club for share;
  select court_id into v_court from bookings where id = v_booking;

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

-- 3 -------------------------------------------------------------------------------------------
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
revoke execute on function book_at_desk(uuid, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function book_at_desk(uuid, timestamptz, timestamptz, uuid) to authenticated;
