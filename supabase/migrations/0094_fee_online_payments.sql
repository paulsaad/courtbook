-- 0094 — M12.1: Model 2 payments. The club collects the court price at its desk; CourtBook collects only its booking
-- fee online (decisions of 24 Nov: Model 2, fee $1, D1 fee-refund rule, up to three attempts per hold).
--
-- Nothing here talks to a provider. A server route asks the provider for the truth and hands it to the database;
-- the database alone decides what a successful charge means. The rules below are what ChatGPT's review and Paul's
-- approval of PR #33 require:
--
--   1. New club mode 'fee_online'. A hold there writes a fee-only payment ($0 court + fee). A club whose fee is $0
--      confirms at once and writes NO payment row (hard criterion 2), exactly like 'at_desk'.
--   2. payment_attempts: one row per request to a provider. Its id is the external reference sent to the provider,
--      so it is never reused (a reused Whish reference replays the old request). At most three per hold; the hold's
--      deadline is never extended. A failed or expired attempt ends only the attempt, never the hold. Only one attempt
--      may be unresolved ('starting' or 'open') at a time: a provider that timed out may still have taken the money, so
--      the attempt stays unresolved until the provider's own status says what happened.
--   3. fee_charges: one row per successful charge, whatever happened to the booking. A charge is either 'kept'
--      (exactly one per paid payment, enforced by a unique index), or owed back ('refund_due' → 'refunded'). Wrong
--      amount, wrong currency, a second success, a success after the hold ended, or a charge nobody can match: all
--      recorded, all owed back (hard criterion 1). One refund per charge, structurally. A second, distinct charge that
--      the provider's own transaction records prove against an attempt already paid is recorded too ('extra_charge'),
--      owed back, without touching the booking (reconcile_provider_charge only; a callback cannot add one).
--   4. record_attempt_result is the only way a fee-only payment becomes paid. It takes the same locks as every other
--      path (club → court → booking → payment, then attempt, then charge) and is idempotent: a repeated callback,
--      return-page check or reconciliation of the same charge changes nothing.
--   5. One fee-refund rule for every cancellation (settle_payment_on_cancel): player or account deletion → fee kept;
--      club-caused (club cancels, court closed) → fee owed back. cancel_booking and delete_account_data both use it.
--   6. CourtBook fee refunds are completed only by an admin (complete_fee_refund), recording amount, method,
--      reference, time and who. Club staff cannot mark them refunded (mark_refunded refuses fee-only payments) and
--      their refund queue and badge no longer list them.
--   7. The Model 1 path (court + fee online, demo clubs only, simulated) is unchanged, except that confirm_payment and
--      fail_payment now refuse fee-only payments: those have no evidence without an attempt.
--
-- Lock order everywhere: club (share) → court → booking → payment → payment_attempts → fee_charges.
--
-- hold_slot below keeps the pilot's 0093 refusal (PR-8): a closed account is refused while holding its profile row and
-- before locking any court (club FOR SHARE → profile FOR UPDATE → deletion_requested() → courts), so this migration
-- cannot bring back the deadlock with delete_account_data (courts → profile). Same line as 0093; see its header.

-- ------------------------------------------------------------------ 1. the mode and the shape of a fee-only payment
alter table clubs drop constraint if exists clubs_payment_mode_check;
alter table clubs add constraint clubs_payment_mode_check check (payment_mode in ('simulated', 'at_desk', 'fee_online'));

alter table payments add column if not exists kind text not null default 'court_and_fee';
alter table payments drop constraint if exists payments_kind_check;
alter table payments add constraint payments_kind_check check (kind in ('court_and_fee', 'fee_only'));
alter table payments drop constraint if exists payments_fee_only_shape;
-- a fee-only payment is exactly the fee, in dollars, and never $0 (hard criterion 2)
alter table payments add constraint payments_fee_only_shape
  check (kind <> 'fee_only' or (amount_usd = 0 and fee_usd > 0 and total_usd = fee_usd and currency = 'USD'));

-- ------------------------------------------------------------------ 2. attempts
create table if not exists payment_attempts (
  id               uuid primary key default gen_random_uuid(),   -- the external reference sent to the provider
  payment_id       uuid not null references payments(id),
  club_id          uuid not null references clubs(id),
  attempt_no       int  not null check (attempt_no between 1 and 3),
  request_key      uuid not null,                                -- the browser's idempotency key for "pay"
  provider         text not null check (provider in ('simulated', 'whish', 'areeba')),
  status           text not null default 'starting' check (status in ('starting', 'open', 'succeeded', 'failed', 'expired')),
  amount_usd       numeric(8,2) not null check (amount_usd > 0),
  currency         text not null default 'USD',
  session_url      text,
  provider_session text,
  provider_ref     text,                                         -- the provider's own id for the charge
  outcome          text check (outcome in ('confirmed', 'late', 'duplicate', 'wrong_amount', 'wrong_currency')),
  note             text,
  created_at       timestamptz not null default now(),
  finished_at      timestamptz,
  last_checked_at  timestamptz,
  checks           int not null default 0,
  unique (payment_id, attempt_no),
  unique (payment_id, request_key),
  unique (provider, provider_ref),
  check ((status = 'succeeded') = (outcome is not null)),
  check (status <> 'succeeded' or provider_ref is not null)
);
create index if not exists payment_attempts_open_idx on payment_attempts (created_at) where status in ('starting', 'open');
create index if not exists payment_attempts_payment_idx on payment_attempts (payment_id);

-- ------------------------------------------------------------------ 3. every successful charge
create table if not exists fee_charges (
  id               uuid primary key default gen_random_uuid(),
  provider         text not null check (provider in ('simulated', 'whish', 'areeba')),
  provider_ref     text not null,
  attempt_id       uuid references payment_attempts(id),         -- null only for a charge nobody could match
  payment_id       uuid references payments(id),
  club_id          uuid references clubs(id),
  amount           numeric(8,2) not null check (amount > 0),
  currency         text not null,
  collected        boolean not null,                             -- false only for the simulated provider
  received_at      timestamptz not null default now(),
  disposition      text not null check (disposition in ('kept', 'refund_due', 'refunded')),
  reason           text check (reason in ('club_cancelled', 'not_confirmed', 'duplicate', 'wrong_amount', 'wrong_currency', 'unmatched', 'extra_charge')),
  refund_due_at    timestamptz,
  refunded_at      timestamptz,
  refunded_by      uuid references profiles(id) on delete set null,
  refund_method    text check (refund_method in ('provider_portal', 'provider_api')),
  refund_reference text,
  refund_amount    numeric(8,2),
  unique (provider, provider_ref),
  check ((disposition = 'kept') = (reason is null)),
  check (disposition <> 'kept' or (payment_id is not null and attempt_id is not null)),
  check (attempt_id is not null or reason = 'unmatched'),
  check (disposition = 'kept' or refund_due_at is not null),
  check ((disposition = 'refunded') = (refunded_at is not null and refund_method is not null and refund_reference is not null and refund_amount is not null)),
  check (refund_amount is null or refund_amount = amount)
);
-- one charge per attempt as the attempt's own result; any further, distinct charge on it is an 'extra_charge' (owed back)
create unique index if not exists fee_charges_one_per_attempt on fee_charges (attempt_id) where reason is distinct from 'extra_charge';
-- one kept charge per payment: a booking can never be confirmed by two charges
create unique index if not exists fee_charges_one_kept on fee_charges (payment_id) where disposition = 'kept';
-- one provider refund can settle only one charge
create unique index if not exists fee_charges_refund_reference on fee_charges (provider, refund_reference) where refund_reference is not null;
create index if not exists fee_charges_due_idx on fee_charges (refund_due_at) where disposition = 'refund_due';

alter table payment_attempts enable row level security;
alter table fee_charges enable row level security;
revoke all on payment_attempts, fee_charges from public, anon, authenticated;
grant select on payment_attempts, fee_charges to authenticated;
grant all on payment_attempts, fee_charges to service_role;
drop policy if exists "payment attempts: read own or admin" on payment_attempts;
create policy "payment attempts: read own or admin" on payment_attempts for select to authenticated
  using (is_admin() or exists (select 1 from payments p where p.id = payment_id and p.profile_id = auth.uid()));
drop policy if exists "fee charges: admin" on fee_charges;
create policy "fee charges: admin" on fee_charges for select to authenticated using (is_admin());

-- ------------------------------------------------------------------ 4. the club's mode
create or replace function set_club_payment_mode(p_club uuid, p_mode text) returns integer
language plpgsql security definer set search_path = public as $$
declare n int := 0; v_old text; v_demo boolean;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not is_admin() then raise exception 'forbidden'; end if;
  if p_mode not in ('simulated', 'at_desk', 'fee_online') then raise exception 'bad_payment_mode'; end if;
  select payment_mode, is_demo into v_old, v_demo from clubs where id = p_club for update;
  if not found then raise exception 'club_not_found'; end if;
  if p_mode = 'simulated' and not v_demo then raise exception 'simulated_demo_only'; end if;  -- 0070
  -- 0094: a real club takes fees online only once a real provider is configured; otherwise every hold would be refused
  if p_mode = 'fee_online' and not v_demo
     and coalesce(nullif(current_setting('app.payment_provider', true), ''), 'simulated') = 'simulated' then
    raise exception 'payments_not_configured';
  end if;
  if p_mode = v_old then return 0; end if;

  -- 0094: every change of mode releases the holds made under the old one (before, only a switch to at_desk did),
  -- BEFORE the club flips, or the at_desk trigger would refuse to expire their payments. An attempt still open on a
  -- released hold stays open: if it succeeds, the charge is recorded and owed back (record_attempt_result).
  update bookings set status = 'expired' where club_id = p_club and status = 'pending';
  get diagnostics n = row_count;
  update payments p set status = 'expired'
  from bookings b where p.booking_id = b.id and b.club_id = p_club and b.status = 'expired' and p.status = 'pending';

  update clubs set payment_mode = p_mode where id = p_club;
  return n;   -- holds released by the switch
end $$;

-- ------------------------------------------------------------------ 5. the hold
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
  v_provider text := coalesce(nullif(current_setting('app.payment_provider', true), ''), 'simulated');
  v_upcoming int;
  e bookings%rowtype;
begin
  if v_player is null then raise exception 'not_authenticated'; end if;
  if p_start <= now() then raise exception 'slot_in_past'; end if;

  -- club first, and held: the mode cannot flip while this hold is being created
  select * into c from clubs where id = p_club and active for share;
  if not found then raise exception 'club_not_found'; end if;
  if c.payment_mode = 'at_desk' then raise exception 'wrong_payment_mode'; end if;
  -- 0094: a real club never takes a simulated fee
  if c.payment_mode = 'fee_online' and v_provider = 'simulated' and not c.is_demo then raise exception 'payments_not_configured'; end if;
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
  -- Refused HERE, holding the profile row and no court yet (0093, pilot; see its header)
  if deletion_requested(v_player) then raise exception 'account_closed'; end if;
  perform lock_courts(coalesce(v_courts, array[p_court]));

  perform 1 from bookings where player_id = v_player and status = 'pending' for update;
  update bookings set status = 'expired' where player_id = v_player and status = 'pending';
  update payments p set status = 'expired'
  from bookings b where p.booking_id = b.id and b.player_id = v_player and b.status = 'expired' and p.status = 'pending';

  perform expire_stale_holds(p_court);
  perform assert_valid_court_slot(p_club, p_court, p_start, p_end);
  v_price := quote_price(p_court, p_start, p_end);
  v_exp := now() + make_interval(mins => c.hold_minutes);

  if c.payment_mode = 'fee_online' then
    -- the same cap as a pay-at-the-desk booking (book_at_desk): these clubs replace at_desk ones
    select count(*) into v_upcoming from bookings
    where player_id = v_player and club_id = p_club and status = 'confirmed' and start_at > now();
    if v_upcoming >= c.max_upcoming_bookings then raise exception 'too_many_upcoming'; end if;

    if c.service_fee_usd = 0 then
      -- hard criterion 2: a $0 fee is the pay-at-the-desk path. Confirmed at once, no payment row of any kind.
      insert into bookings (id, club_id, court_id, player_id, start_at, end_at, status, source, created_by,
                            price_usd, fee_usd, client_token)
      values (v_booking, p_club, p_court, v_player, p_start, p_end, 'confirmed', 'app', v_player, v_price, 0, p_token);
      return query select v_booking, null::uuid, 0::numeric, 0::numeric, 0::numeric, null::timestamptz, false;
      return;
    end if;

    -- the court price is frozen on the booking (paid at the desk); online, only the fee
    insert into bookings (id, club_id, court_id, player_id, start_at, end_at, status, source, created_by,
                          hold_expires_at, price_usd, fee_usd, client_token)
    values (v_booking, p_club, p_court, v_player, p_start, p_end, 'pending', 'app', v_player, v_exp, v_price, c.service_fee_usd, p_token);
    insert into payments (id, booking_id, profile_id, club_id, provider, kind, amount_usd, fee_usd, total_usd)
    values (v_payment, v_booking, v_player, p_club, v_provider, 'fee_only', 0, c.service_fee_usd, c.service_fee_usd);
    return query select v_booking, v_payment, 0::numeric, c.service_fee_usd, c.service_fee_usd, v_exp, false;
    return;
  end if;

  -- 'simulated' (demo clubs, Model 1): court + fee online, unchanged
  insert into bookings (id, club_id, court_id, player_id, start_at, end_at, status, source, created_by,
                        hold_expires_at, price_usd, fee_usd, client_token)
  values (v_booking, p_club, p_court, v_player, p_start, p_end, 'pending', 'app', v_player, v_exp, v_price, c.service_fee_usd, p_token);

  insert into payments (id, booking_id, profile_id, club_id, provider, amount_usd, fee_usd, total_usd)
  values (v_payment, v_booking, v_player, p_club, v_provider, v_price, c.service_fee_usd, v_price + c.service_fee_usd);

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

-- ------------------------------------------------------------------ 6. starting an attempt (the player, through the pay route)
create or replace function start_payment_attempt(p_payment uuid, p_request uuid)
returns table (attempt_id uuid, attempt_no int, provider text, amount_usd numeric, currency text, status text,
               session_url text, hold_expires_at timestamptz, already boolean)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_player uuid := auth.uid();
  p payments%rowtype;
  b bookings%rowtype;
  a payment_attempts%rowtype;
  v_court uuid;
  v_n int;
begin
  if v_player is null then raise exception 'not_authenticated'; end if;
  if p_request is null then raise exception 'token_required'; end if;
  select * into p from payments where id = p_payment;
  if not found or p.profile_id is distinct from v_player then raise exception 'not_found'; end if;
  if p.kind <> 'fee_only' then raise exception 'wrong_payment_mode'; end if;

  perform 1 from clubs where id = p.club_id for share;
  select court_id into v_court from bookings where id = p.booking_id;
  if v_court is not null then perform 1 from courts where id = v_court for update; end if;
  select * into b from bookings where id = p.booking_id for update;
  select * into p from payments where id = p_payment for update;
  perform 1 from payment_attempts where payment_id = p.id for update;

  -- the same request again (a double tap, a retry after a lost answer): the attempt it already made
  select * into a from payment_attempts where payment_id = p.id and request_key = p_request;
  if found then
    return query select a.id, a.attempt_no, a.provider, a.amount_usd, a.currency, a.status, a.session_url, b.hold_expires_at, true;
    return;
  end if;

  if p.status <> 'pending' or b.status <> 'pending' then raise exception 'not_payable'; end if;
  -- a new attempt needs a live hold; the deadline is never moved
  if b.hold_expires_at is null or b.hold_expires_at <= now() then raise exception 'hold_expired'; end if;
  select count(*) into v_n from payment_attempts where payment_id = p.id;
  if v_n >= 3 then raise exception 'attempts_exhausted'; end if;
  -- review of PR #34: never two unresolved attempts at once. An attempt still 'starting' or 'open' may yet take the
  -- money (a provider timeout is not a refusal); the server asks the provider about it first (/api/pay/start).
  if exists (select 1 from payment_attempts where payment_id = p.id and status in ('starting', 'open')) then
    raise exception 'attempt_in_progress';
  end if;

  insert into payment_attempts (payment_id, club_id, attempt_no, request_key, provider, amount_usd, currency)
  values (p.id, p.club_id, v_n + 1, p_request, p.provider, p.total_usd, p.currency)
  returning * into a;
  return query select a.id, a.attempt_no, a.provider, a.amount_usd, a.currency, a.status, a.session_url, b.hold_expires_at, false;
end $$;
revoke all on function start_payment_attempt(uuid, uuid) from public, anon;
grant execute on function start_payment_attempt(uuid, uuid) to authenticated;

-- the provider created a payment page for the attempt (server only)
create or replace function open_payment_attempt(p_attempt uuid, p_session_url text, p_provider_session text)
returns text language plpgsql security definer set search_path = public as $$
declare v_status text;
begin
  update payment_attempts set status = 'open', session_url = p_session_url, provider_session = p_provider_session
  where id = p_attempt and status = 'starting'
  returning status into v_status;
  if v_status is null then
    select status into v_status from payment_attempts where id = p_attempt;
    if v_status is null then raise exception 'attempt_not_found'; end if;
  end if;
  return v_status;
end $$;

-- the provider refused to start the attempt (server only). It counts as one of the three.
create or replace function abandon_payment_attempt(p_attempt uuid, p_note text)
returns text language plpgsql security definer set search_path = public as $$
declare v_status text;
begin
  update payment_attempts set status = 'failed', finished_at = now(), note = left(p_note, 200)
  where id = p_attempt and status = 'starting'
  returning status into v_status;
  if v_status is null then
    select status into v_status from payment_attempts where id = p_attempt;
    if v_status is null then raise exception 'attempt_not_found'; end if;
  end if;
  return v_status;
end $$;

-- ------------------------------------------------------------------ 7. what the provider says about an attempt (server only)
-- p_result: 'succeeded' (money taken: p_provider_ref, p_amount and p_currency required), 'failed', 'expired', 'pending'.
-- Returns: 'confirmed' | 'late' | 'duplicate' | 'wrong_amount' | 'wrong_currency' (each of the last four recorded a
-- refund obligation) | 'already_recorded' | 'failed' | 'expired' | 'pending' | 'ignored'.
create or replace function record_attempt_result(p_attempt uuid, p_result text, p_provider_ref text default null,
                                                 p_amount numeric default null, p_currency text default null)
returns text language plpgsql security definer set search_path = public as $$
declare
  a payment_attempts%rowtype;
  p payments%rowtype;
  b bookings%rowtype;
  v_court uuid;
  v_real boolean;
  v_outcome text;
  v_reason text;
  v_note text;
  v_currency text := upper(btrim(p_currency));
  v_ref text := btrim(p_provider_ref);
begin
  if p_result is null or p_result not in ('succeeded', 'failed', 'expired', 'pending') then raise exception 'bad_result'; end if;
  select * into a from payment_attempts where id = p_attempt;
  if not found then raise exception 'attempt_not_found'; end if;

  -- club → court → booking → payment → attempt
  perform 1 from clubs where id = a.club_id for share;
  select bk.court_id into v_court from payments py join bookings bk on bk.id = py.booking_id where py.id = a.payment_id;
  if v_court is not null then perform 1 from courts where id = v_court for update; end if;
  select bk.* into b from bookings bk where bk.id = (select booking_id from payments where id = a.payment_id) for update;
  select * into p from payments where id = a.payment_id for update;
  select * into a from payment_attempts where id = p_attempt for update;

  if p_result = 'pending' then
    update payment_attempts set last_checked_at = now(), checks = checks + 1 where id = a.id and status in ('starting', 'open');
    return 'pending';
  end if;

  if p_result in ('failed', 'expired') then
    -- ends the attempt only: the hold stays until its deadline or until the player releases it
    if a.status in ('starting', 'open') then
      update payment_attempts set status = p_result, finished_at = now(), last_checked_at = now(), checks = checks + 1 where id = a.id;
      return p_result;
    end if;
    return 'ignored';   -- a success is never undone by a later failure; a finished attempt stays finished
  end if;

  -- 'succeeded': money was taken. From here on, every path records the charge.
  if v_ref is null or v_ref = '' or p_amount is null or p_amount <= 0 or v_currency is null or v_currency = '' then
    raise exception 'evidence_incomplete';
  end if;
  if a.status = 'succeeded' then
    if a.provider_ref = v_ref and exists (select 1 from fee_charges c where c.attempt_id = a.id and c.reason is distinct from 'extra_charge'
                                          and c.amount = p_amount and c.currency = v_currency) then
      return 'already_recorded';
    end if;
    -- the provider (or someone posing as it) now says something else about the same attempt: refused here. Only the
    -- provider's own transaction records, through reconcile_provider_charge, may add a second charge to it.
    raise exception 'attempt_evidence_conflict';
  end if;
  if exists (select 1 from fee_charges where provider = a.provider and provider_ref = v_ref) then
    raise exception 'duplicate_provider_ref';      -- one provider charge cannot pay for two attempts
  end if;

  v_real := a.provider <> 'simulated';
  if v_currency <> a.currency then v_outcome := 'wrong_currency'; v_reason := 'wrong_currency';
  elsif p_amount <> a.amount_usd then v_outcome := 'wrong_amount'; v_reason := 'wrong_amount';
  elsif p.status = 'paid' then v_outcome := 'duplicate'; v_reason := 'duplicate';
  elsif p.status = 'pending' and b.status = 'pending' then v_outcome := 'confirmed';
  else v_outcome := 'late'; v_reason := 'not_confirmed';
  end if;

  if v_outcome = 'confirmed' then
    -- The hold still owns the slot (pending, even just past its deadline: 0014/0090). A business refusal while
    -- confirming must not lose the charge: it becomes a charge owed back. Transient errors (deadlock, serialization)
    -- are not caught: the whole call fails and the caller asks again.
    begin
      update bookings set status = 'confirmed', hold_expires_at = null where id = b.id;
    exception when exclusion_violation or raise_exception or check_violation or foreign_key_violation then
      v_outcome := 'late'; v_reason := 'not_confirmed'; v_note := left('booking could not be confirmed: ' || sqlerrm, 200);
    end;
  end if;

  update payment_attempts set status = 'succeeded', outcome = v_outcome, provider_ref = v_ref,
         finished_at = now(), last_checked_at = now(), checks = checks + 1, note = coalesce(v_note, note)
  where id = a.id;
  insert into fee_charges (provider, provider_ref, attempt_id, payment_id, club_id, amount, currency, collected,
                           disposition, reason, refund_due_at)
  values (a.provider, v_ref, a.id, a.payment_id, a.club_id, p_amount, v_currency, v_real,
          case when v_outcome = 'confirmed' then 'kept' else 'refund_due' end, v_reason,
          case when v_outcome = 'confirmed' then null else now() end);

  if v_outcome = 'confirmed' then
    update payments set status = 'paid', paid_at = now(), collected = v_real, provider_ref = a.id::text where id = p.id;
    return 'confirmed';
  end if;
  -- money arrived for a payment that no longer waits for it: the payment row says so too (as confirm_payment does).
  -- Simulated money at a club since switched to the desk is left alone (the at_desk trigger refuses it); its charge
  -- above is the record.
  if v_outcome = 'late' and p.status in ('pending', 'expired', 'failed')
     and (v_real or (select payment_mode from clubs where id = a.club_id) <> 'at_desk') then
    update payments set status = 'refund_due', paid_at = now(), collected = v_real, provider_ref = a.id::text,
           note = coalesce(v_note, 'paid after the hold ended or the booking was cancelled')
    where id = p.id;
  end if;
  return v_outcome;
exception when unique_violation then
  -- the same provider reference was recorded by another transaction meanwhile (on another attempt): everything this
  -- call did is undone, and it is refused by name, never answered as a success
  declare v_constraint text;
  begin
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint in ('fee_charges_provider_provider_ref_key', 'payment_attempts_provider_provider_ref_key') then
      raise exception 'duplicate_provider_ref';
    end if;
    raise;
  end;
end $$;

-- ------------------------------------------------------------------ 8. reconciliation (server only)
-- A successful charge seen in the provider's own records. Known attempt → the same path as a callback. Unknown →
-- recorded as a charge owed back ('unmatched'). Running it again for the same charge changes nothing.
--
-- The same provider reference may already be recorded (an earlier run, or a concurrent one whose insert won). It is
-- "already recorded" only if the evidence agrees: same amount, same currency, same attempt (none for an unmatched
-- charge). Anything else is contradictory financial evidence and is refused (charge_evidence_conflict), never answered
-- as a success. Checked before the locks, after them, and after an insert that lost to a concurrent one (review of
-- PR #34 at 45f53dd).
create or replace function fee_charge_already_recorded(p_provider text, p_ref text, p_amount numeric, p_currency text, p_attempt uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare c fee_charges%rowtype;
begin
  select * into c from fee_charges where provider = p_provider and provider_ref = p_ref;
  if not found then return false; end if;
  if c.amount = p_amount and c.currency = p_currency and c.attempt_id is not distinct from p_attempt then return true; end if;
  raise exception 'charge_evidence_conflict';
end $$;
revoke all on function fee_charge_already_recorded(text, text, numeric, text, uuid) from public, anon, authenticated, service_role;

create or replace function reconcile_provider_charge(p_provider text, p_external_ref text, p_provider_ref text,
                                                     p_amount numeric, p_currency text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_attempt uuid; c fee_charges%rowtype; n int; v_ref text := btrim(p_provider_ref); v_currency text := upper(btrim(p_currency));
  a payment_attempts%rowtype; v_court uuid;
begin
  if p_provider is null or p_provider not in ('simulated', 'whish', 'areeba') then raise exception 'bad_provider'; end if;
  if v_ref is null or v_ref = '' or p_amount is null or p_amount <= 0 or v_currency is null or v_currency = '' then
    raise exception 'evidence_incomplete';
  end if;
  begin v_attempt := btrim(p_external_ref)::uuid; exception when invalid_text_representation then v_attempt := null; end;
  select * into a from payment_attempts where id = v_attempt and provider = p_provider;
  if not found then v_attempt := null; end if;                    -- the attempt the provider's record names, if ours
  if fee_charge_already_recorded(p_provider, v_ref, p_amount, v_currency, v_attempt) then return 'already_recorded'; end if;
  if v_attempt is not null then
    -- club → court → booking → payment → attempt, then decide on the locked attempt
    perform 1 from clubs where id = a.club_id for share;
    select bk.court_id into v_court from payments py join bookings bk on bk.id = py.booking_id where py.id = a.payment_id;
    if v_court is not null then perform 1 from courts where id = v_court for update; end if;
    perform 1 from bookings where id = (select booking_id from payments where id = a.payment_id) for update;
    perform 1 from payments where id = a.payment_id for update;
    select * into a from payment_attempts where id = v_attempt for update;
    -- a concurrent run may have recorded this reference while we waited for the locks
    if fee_charge_already_recorded(p_provider, v_ref, p_amount, v_currency, v_attempt) then return 'already_recorded'; end if;
    if a.status <> 'succeeded' then
      begin
        return record_attempt_result(v_attempt, 'succeeded', v_ref, p_amount, v_currency);
      exception when raise_exception then
        -- recorded on ANOTHER attempt by a concurrent transaction: contradictory evidence (or, if it agrees, recorded)
        if sqlerrm <> 'duplicate_provider_ref' then raise; end if;
        if fee_charge_already_recorded(p_provider, v_ref, p_amount, v_currency, v_attempt) then return 'already_recorded'; end if;
        raise exception 'charge_evidence_conflict';
      end;
    end if;
    -- The attempt already has its charge, and the provider's own records show another, distinct one on it (a
    -- different provider reference). That money was taken too: recorded and owed back in full. The booking, the
    -- payment and the attempt's own charge are left exactly as they are.
    insert into fee_charges (provider, provider_ref, attempt_id, payment_id, club_id, amount, currency, collected,
                             disposition, reason, refund_due_at)
    values (a.provider, v_ref, a.id, a.payment_id, a.club_id, p_amount, v_currency, a.provider <> 'simulated',
            'refund_due', 'extra_charge', now())
    on conflict (provider, provider_ref) do nothing;
    get diagnostics n = row_count;
    if n = 1 then return 'extra_charge'; end if;
    if fee_charge_already_recorded(p_provider, v_ref, p_amount, v_currency, v_attempt) then return 'already_recorded'; end if;
    raise exception 'charge_evidence_conflict';    -- not reached: the function above raises on any disagreement
  end if;
  insert into fee_charges (provider, provider_ref, amount, currency, collected, disposition, reason, refund_due_at)
  values (p_provider, v_ref, p_amount, v_currency, p_provider <> 'simulated', 'refund_due', 'unmatched', now())
  on conflict (provider, provider_ref) do nothing;
  get diagnostics n = row_count;
  if n = 1 then return 'unmatched'; end if;
  -- a concurrent run inserted this reference first: success only if its evidence is the same
  if fee_charge_already_recorded(p_provider, v_ref, p_amount, v_currency, null) then return 'already_recorded'; end if;
  raise exception 'charge_evidence_conflict';
end $$;

-- attempts the server should ask the provider about (sweeper): still open, older than p_min_age, younger than p_max_age
create or replace function attempts_to_check(p_min_age interval, p_max_age interval, p_limit int)
returns table (attempt_id uuid, provider text, status text, created_at timestamptz, last_checked_at timestamptz)
language sql stable security definer set search_path = public as $$
  select a.id, a.provider, a.status, a.created_at, a.last_checked_at
  from payment_attempts a
  where a.status in ('starting', 'open') and a.created_at < now() - p_min_age and a.created_at > now() - p_max_age
  order by a.last_checked_at nulls first, a.created_at
  limit greatest(1, least(p_limit, 200));
$$;

revoke all on function open_payment_attempt(uuid, text, text) from public, anon, authenticated;
revoke all on function abandon_payment_attempt(uuid, text) from public, anon, authenticated;
revoke all on function record_attempt_result(uuid, text, text, numeric, text) from public, anon, authenticated;
revoke all on function reconcile_provider_charge(text, text, text, numeric, text) from public, anon, authenticated;
revoke all on function attempts_to_check(interval, interval, int) from public, anon, authenticated;
grant execute on function open_payment_attempt(uuid, text, text), abandon_payment_attempt(uuid, text),
  record_attempt_result(uuid, text, text, numeric, text), reconcile_provider_charge(text, text, text, numeric, text),
  attempts_to_check(interval, interval, int) to service_role;

-- ------------------------------------------------------------------ 9. the one fee-refund rule for every cancellation
-- Called by cancel_booking and delete_account_data, which already hold court → booking (and have not yet changed the
-- booking's status). p_cause: 'player' (the player, or the desk on the player's behalf), 'club' (the club cancels or
-- closes the court), 'account_deleted'. Returns true when a refund obligation was created.
create or replace function settle_payment_on_cancel(p_booking uuid, p_cause text) returns boolean
language plpgsql security definer set search_path = public as $$
declare b bookings%rowtype; p payments%rowtype; v_cutoff int; n int;
begin
  if p_cause is null or p_cause not in ('player', 'club', 'account_deleted') then raise exception 'bad_cause'; end if;
  select * into b from bookings where id = p_booking;
  select * into p from payments where booking_id = p_booking for update;
  if not found then return false; end if;               -- desk or $0-fee booking: no CourtBook money
  if b.status = 'pending' then
    update payments set status = 'expired' where id = p.id and status = 'pending';
    return false;                                       -- an open attempt that later succeeds is owed back (late)
  end if;
  if b.status <> 'confirmed' then return false; end if;

  if p.kind = 'fee_only' then
    if p_cause <> 'club' then return false; end if;     -- D1: the player's own cancellation keeps the fee, at any time
    perform 1 from payment_attempts where payment_id = p.id for update;
    update fee_charges set disposition = 'refund_due', reason = 'club_cancelled', refund_due_at = now()
    where payment_id = p.id and disposition = 'kept';
    get diagnostics n = row_count;
    update payments set status = 'refund_due', note = 'club-caused cancellation' where id = p.id and status = 'paid';
    return n > 0;
  end if;

  -- court and fee paid online (demo clubs, Model 1): unchanged — club-caused, or before the club's cutoff
  select cancel_cutoff_hours into v_cutoff from clubs where id = b.club_id;
  if p_cause = 'club' or b.start_at - make_interval(hours => v_cutoff) > now() then
    update payments set status = 'refund_due',
      note = case p_cause when 'club' then 'club-caused cancellation'
                          when 'account_deleted' then 'cancelled before cutoff (account deleted)'
                          else 'cancelled before cutoff' end
    where id = p.id and status = 'paid';
    get diagnostics n = row_count;
    return n > 0;
  end if;
  return false;
end $$;
revoke all on function settle_payment_on_cancel(uuid, text) from public, anon, authenticated, service_role;

create or replace function cancel_booking(p_booking uuid, p_club_caused boolean default false) returns void
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
  -- 0083: a player cancels only before the start; a booking being played or over is the club's record (staff can still
  -- correct it). A hold can still be released.
  if not is_staff and b.status = 'confirmed' and b.start_at <= now() then raise exception 'booking_started'; end if;

  -- 0094: the money follows the one shared rule (fee kept on the player's cancellation; owed back when club-caused)
  perform settle_payment_on_cancel(p_booking, case when p_club_caused then 'club' else 'player' end);

  update bookings set status = 'cancelled', cancelled_at = now() where id = p_booking;

  -- legacy credits keep their rule
  select cancel_cutoff_hours into cutoff from clubs where id = b.club_id;
  refund := p_club_caused or b.start_at - make_interval(hours => cutoff) > now();
  if b.credit_tx_id is not null and refund then
    insert into credit_transactions (profile_id, delta, kind, booking_id, created_by)
    values (b.player_id, +1, 'refund', b.id, auth.uid());
  end if;
end $$;

-- ------------------------------------------------------------------ 10. the Model 1 functions refuse fee-only payments
create or replace function confirm_payment(p_payment uuid, p_provider_ref text, p_total_usd numeric) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_booking uuid; v_court uuid; v_club uuid; v_real boolean;
  p payments%rowtype; b bookings%rowtype;
begin
  select booking_id, club_id into v_booking, v_club from payments where id = p_payment;
  if v_booking is null then raise exception 'payment_not_found'; end if;
  perform 1 from clubs where id = v_club for share;          -- club → court → booking → payment
  select court_id into v_court from bookings where id = v_booking;

  if v_court is not null then perform 1 from courts where id = v_court for update; end if;
  select * into b from bookings where id = v_booking for update;
  select * into p from payments where id = p_payment for update;
  -- 0094: a fee-only payment is paid only through a provider-verified attempt (record_attempt_result)
  if p.kind = 'fee_only' then raise exception 'use_payment_attempts'; end if;
  v_real := p.provider <> 'simulated';

  -- a club settling at its own desk takes nothing through CourtBook, so a simulated confirmation is
  -- never real money. A real gateway's receipt still lands: refusing it would leave a genuine
  -- obligation unrecorded.
  if not v_real and (select payment_mode from clubs where id = v_club) = 'at_desk' then
    raise exception 'wrong_payment_mode';
  end if;

  if p.status = 'paid' then
    if p.provider_ref = p_provider_ref and p.total_usd = p_total_usd then return 'already_paid'; end if;
    raise exception 'payment_mismatch';
  end if;
  if p.status in ('refund_due', 'refunded') then return p.status::text; end if;
  if p.total_usd <> p_total_usd then raise exception 'amount_mismatch'; end if;
  if exists (select 1 from payments where provider_ref = p_provider_ref and id <> p_payment) then
    raise exception 'duplicate_provider_ref';
  end if;

  if b.status = 'pending' then
    update bookings set status = 'confirmed', hold_expires_at = null where id = b.id;
    update payments set status = 'paid', paid_at = now(), collected = v_real, provider_ref = p_provider_ref where id = p.id;
    return 'confirmed';
  end if;

  -- the gateway took the money after the hold had gone: owed back, and we know when it arrived
  update payments set status = 'refund_due', paid_at = now(), collected = v_real, provider_ref = p_provider_ref,
    note = 'paid after hold expired or booking cancelled' where id = p.id;
  return 'refund_due';
end $$;

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
  -- 0094: a failed fee-only attempt ends the attempt, never the hold (record_attempt_result)
  if p.kind = 'fee_only' then raise exception 'use_payment_attempts'; end if;
  if p.status <> 'pending' then return; end if;
  update payments set status = 'failed', note = p_note where id = p.id;
  update bookings set status = 'expired' where id = v_booking and status = 'pending';
end $$;

-- ------------------------------------------------------------------ 11. refunds of CourtBook's fee: admin only
create or replace function mark_refunded(p_payment uuid) returns void
language plpgsql security definer set search_path = public as $$
declare p payments%rowtype;
begin
  select * into p from payments where id = p_payment for update;
  if not found then raise exception 'not_found'; end if;
  if auth.uid() is not null and not is_staff_of(p.club_id) then raise exception 'forbidden'; end if;
  -- 0094: the booking fee is CourtBook's money; only an admin completes its refund, with a reference (complete_fee_refund)
  if p.kind = 'fee_only' then raise exception 'courtbook_fee_refund'; end if;
  if p.status <> 'refund_due' then raise exception 'not_refund_due'; end if;
  if not p.collected then raise exception 'never_collected'; end if;
  update payments set status = 'refunded', refunded_at = now() where id = p_payment;
end $$;

create or replace function complete_fee_refund(p_charge uuid, p_amount numeric, p_method text, p_reference text)
returns text language plpgsql security definer set search_path = public as $$
declare c fee_charges%rowtype; v_ref text := btrim(p_reference);
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not is_admin() then raise exception 'forbidden'; end if;
  if p_method is null or p_method not in ('provider_portal', 'provider_api') then raise exception 'bad_method'; end if;
  if v_ref is null or v_ref = '' or char_length(v_ref) > 120 then raise exception 'reference_required'; end if;
  select * into c from fee_charges where id = p_charge;
  if not found then raise exception 'not_found'; end if;
  -- payment → attempt → charge
  if c.payment_id is not null then perform 1 from payments where id = c.payment_id for update; end if;
  if c.attempt_id is not null then perform 1 from payment_attempts where id = c.attempt_id for update; end if;
  select * into c from fee_charges where id = p_charge for update;

  if c.disposition = 'refunded' then
    if c.refund_reference = v_ref and c.refund_amount = p_amount then return 'already_refunded'; end if;
    raise exception 'already_refunded';
  end if;
  if c.disposition <> 'refund_due' then raise exception 'not_refund_due'; end if;
  if not c.collected then raise exception 'never_collected'; end if;
  if p_amount is distinct from c.amount then raise exception 'refund_amount_mismatch'; end if;

  update fee_charges set disposition = 'refunded', refunded_at = now(), refunded_by = auth.uid(),
         refund_method = p_method, refund_reference = v_ref, refund_amount = p_amount
  where id = c.id;
  -- the payment row follows when this charge is the one it stands for
  update payments set status = 'refunded', refunded_at = now()
  where id = c.payment_id and status = 'refund_due' and provider_ref = c.attempt_id::text and c.reason is distinct from 'extra_charge';
  return 'refunded';
exception when unique_violation then raise exception 'refund_reference_used';
end $$;
revoke all on function complete_fee_refund(uuid, numeric, text, text) from public, anon;
grant execute on function complete_fee_refund(uuid, numeric, text, text) to authenticated;

-- the admin's queue of CourtBook fees owed back (real money only; simulated charges are never refunds)
create or replace function fee_refunds_due()
returns table (charge_id uuid, club_name text, provider text, provider_ref text, amount numeric, currency text,
               reason text, since timestamptz, court_name text, start_at timestamptz)
language sql stable security definer set search_path = public as $$
  select c.id, cl.name, c.provider, c.provider_ref, c.amount, c.currency, c.reason, c.refund_due_at, k.name, b.start_at
  from fee_charges c
  left join clubs cl on cl.id = c.club_id
  left join payments p on p.id = c.payment_id
  left join bookings b on b.id = p.booking_id
  left join courts k on k.id = b.court_id
  where c.disposition = 'refund_due' and c.collected and is_admin()
  order by c.refund_due_at;
$$;
revoke all on function fee_refunds_due() from public, anon;
grant execute on function fee_refunds_due() to authenticated;

-- the club's refund queue: only what the club itself owes (court-and-fee payments), never CourtBook's fee
create or replace function refunds_due()
returns table (payment_id uuid, club_id uuid, club_name text, player_name text, court_name text, start_at timestamptz,
               total_usd numeric, note text, since timestamptz)
language sql stable security definer set search_path = public as $$
  select p.id, c.id, c.name, pr.name, k.name, b.start_at, p.total_usd, p.note, b.cancelled_at
  from payments p
  join clubs c on c.id = p.club_id
  join bookings b on b.id = p.booking_id
  left join courts k on k.id = b.court_id
  left join profiles pr on pr.id = p.profile_id
  where p.status = 'refund_due' and p.collected and p.kind = 'court_and_fee' and is_staff_of(p.club_id)
  order by b.cancelled_at nulls last;
$$;

create or replace function payments_summary(p_month date)
returns table (club_id uuid, club_name text, bookings int, gross numeric, fees numeric,
               owed_to_club numeric, refunds_due int, refunded numeric,
               simulated_bookings int, simulated_total numeric, simulated_refunds int)
language sql stable security definer set search_path = public as $$
  select c.id, c.name,
         count(*) filter (where p.status = 'paid' and p.collected)::int,
         coalesce(sum(p.total_usd)  filter (where p.status = 'paid' and p.collected), 0),
         coalesce(sum(p.fee_usd)    filter (where p.status = 'paid' and p.collected), 0),
         coalesce(sum(p.amount_usd) filter (where p.status = 'paid' and p.collected), 0),
         -- only money that was taken can be owed back; 0094: and only the club's own (CourtBook refunds its fee)
         count(*) filter (where p.status = 'refund_due' and p.collected and p.kind = 'court_and_fee')::int,
         coalesce(sum(p.total_usd)  filter (where p.status = 'refunded' and p.collected), 0),
         count(*) filter (where p.status = 'paid' and not p.collected)::int,
         coalesce(sum(p.total_usd)  filter (where p.status = 'paid' and not p.collected), 0),
         count(*) filter (where p.status = 'refund_due' and not p.collected and p.kind = 'court_and_fee')::int
  from clubs c
  left join payments p on p.club_id = c.id
    and p.paid_at >= date_trunc('month', p_month)
    and p.paid_at <  date_trunc('month', p_month) + interval '1 month'
  where is_staff_of(c.id)
  group by c.id, c.name
  order by c.name;
$$;

-- ------------------------------------------------------------------ 12. moving a fee-only booking
-- Only the fee was paid online; the court is paid at the desk. So a move prices like an unpaid app booking (a length
-- change needs the player's agreement on the new price), not like a court paid in the app (length change refused).
create or replace function move_price_plan(b bookings, p_court uuid, p_start timestamptz, p_end timestamptz,
  out current_price numeric, out new_price numeric, out kind text)
language plpgsql stable set search_path = public as $$
declare v_len_changed boolean := (p_end - p_start) <> (b.end_at - b.start_at);
begin
  current_price := b.price_usd;
  if b.source = 'staff' then
    new_price := quote_price(p_court, p_start, p_end);
    kind := case when new_price = b.price_usd then 'same' else 'reprice' end;
  elsif exists (select 1 from payments py where py.booking_id = b.id and py.kind = 'court_and_fee') then
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

-- ------------------------------------------------------------------ 13. account deletion uses the shared rule
create or replace function public.delete_account_data(p_subject uuid, p_cancel_only boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  d account_deletions%rowtype;
  refusal text;
  r record;
  n_games int := 0; n_cancelled int := 0; n_refund int := 0; n_anon int; n_msgs int; n_left int; n_notes int;
  v_name text;
  susp jsonb;
begin
  if not (auth.uid() is null or is_admin()) then raise exception 'forbidden'; end if;
  if p_subject is null then raise exception 'not_found'; end if;
  select * into d from account_deletions where subject_id = p_subject and status in ('requested', 'closing', 'closed', 'held', 'data_removed') for update;
  if not found then raise exception 'no_open_request'; end if;
  if d.status = 'held' and not p_cancel_only then raise exception 'held: %', d.held_reason; end if;   -- 0086: held accounts keep their data
  if p_cancel_only and d.status <> 'held' then raise exception 'not_held'; end if;
  -- Re-running after the data step is allowed and repeats it: every step only touches what is still there, so a
  -- second run changes nothing — unless something arrived in between (a hold that was being written while the first
  -- run ran), which it then cancels and anonymises too. The first run's counts are kept; a re-run is recorded.
  refusal := deletion_refusal(p_subject);
  if refusal is not null and not (p_cancel_only and refusal in ('legal_hold', 'coach_has_bookings')) then raise exception '%', refusal; end if;

  -- Lock order, same as every other path: courts (sorted, as lock_courts does for move_booking and the desk), then
  -- games, then bookings, then payments. cancel_booking and the booking→game trigger take courts → booking → game,
  -- so taking every court first leaves no cycle with them.
  perform lock_courts(coalesce((select array_agg(distinct b.court_id) from bookings b
     where b.court_id is not null and b.status in ('confirmed', 'pending')
       and (b.player_id = p_subject or b.id in (select m.booking_id from matches m where m.organizer_id = p_subject))), '{}'));
  -- Wait for any booking, game or message for this person still being written by another transaction: each holds a
  -- key-share lock on the profile row (foreign-key check) until it commits, and FOR UPDATE waits for it. New ones are
  -- refused by the insert guards, since the request is open. Then lock any court that only now appears (a hold placed
  -- on a court none of their bookings used): the cancellation loop below sees and cancels it.
  perform 1 from profiles where id = p_subject for update;
  perform lock_courts(coalesce((select array_agg(distinct b.court_id) from bookings b
     where b.court_id is not null and b.status in ('confirmed', 'pending') and b.player_id = p_subject), '{}'));
  select name into v_name from profiles where id = p_subject;

  -- (a) upcoming games they organise: cancelled, players told (before the bookings, so no "court lost" notices)
  for r in select * from matches where organizer_id = p_subject and status <> 'cancelled'
             and coalesce(end_at, start_at + interval '3 hours') > now() for update loop
    update matches set status = 'cancelled', closed_at = now(), closed_reason = null where id = r.id;
    insert into notifications (profile_id, kind, match_id, body)
    select mp.profile_id, 'match_cancelled', r.id, 'Match cancelled: the organizer closed their account'
      from match_players mp where mp.match_id = r.id and mp.status in ('accepted', 'pending') and mp.profile_id <> p_subject;
    n_games := n_games + 1;
  end loop;

  -- (b) their future and pending bookings: cancelled as the player would cancel them (0094: through the one shared
  --     rule, settle_payment_on_cancel). Pending → payment expired. A CourtBook booking fee (fee_only) is kept, as when
  --     the player cancels (decision D1); refunds already owed for club or system failures and payment errors are left
  --     as they are. A court-and-fee payment (demo clubs) keeps its rule: refund due before the club's cutoff.
  --     Lock order as cancel_booking: court, then booking, then payment (and its attempts and charges). Legacy credits
  --     are not re-issued.
  for r in select b.id, b.court_id, b.club_id from bookings b
             where b.player_id = p_subject
               and (b.status = 'pending' or (b.status = 'confirmed' and b.start_at > now()))  -- every hold, even a stale one
             order by b.start_at loop
    perform 1 from bookings where id = r.id for update;
    if settle_payment_on_cancel(r.id, 'account_deleted') then n_refund := n_refund + 1; end if;
    update bookings set status = 'cancelled', cancelled_at = now() where id = r.id;
    n_cancelled := n_cancelled + 1;
  end loop;

  if not p_cancel_only then   -- 0086: (c)–(e) only when the data is really to be removed
  -- (c) every booking of theirs stays as the club's and accounting record, anonymised
  update bookings set player_id = null, guest_name = 'Former player', guest_phone = null where player_id = p_subject;
  get diagnostics n_anon = row_count;

  -- (d) chat messages deleted (a report keeps its snapshot); out of every game's player list
  delete from match_messages where profile_id = p_subject;
  get diagnostics n_msgs = row_count;
  end if;
  -- leaving upcoming games of others as leave_match does: organiser told, a game closed only because it was full reopens
  for r in select m.*, mp.status as was from match_players mp join matches m on m.id = mp.match_id
             where mp.profile_id = p_subject and m.status <> 'cancelled' and m.start_at > now() for update of m loop
    delete from match_players where match_id = r.id and profile_id = p_subject;
    if r.was = 'accepted' then
      insert into notifications (profile_id, kind, match_id, body)
      select r.organizer_id, 'player_left', r.id, 'A player left your match' where r.organizer_id is not null;
      if r.status = 'closed' and r.closed_reason = 'full'
         and (select count(*) from match_players where match_id = r.id and status = 'accepted') < r.players_needed then
        update matches set status = 'open', closed_at = null, closed_reason = null where id = r.id;
      end if;
    end if;
  end loop;
  if p_cancel_only then     -- 0086 held account: record what was cancelled; status stays held, data kept
    update account_deletions set cancellations_at = coalesce(cancellations_at, now()),
      summary = coalesce(summary, '{}'::jsonb) || jsonb_build_object('held_cancellations', jsonb_build_object('at', now(),
        'games_cancelled', n_games, 'bookings_cancelled', n_cancelled, 'refunds_due', n_refund))
     where id = d.id returning summary into susp;
    return susp;
  end if;
  delete from match_players where profile_id = p_subject;              -- past games: off the list too

  -- (d2) what others hold about them: chat excerpts in others' notifications go; their name in other notices becomes
  --      "A player"; notes on games they organised (free text: could hold a phone number) are cleared; their own
  --      Help & Feedback messages go (support, not moderation). Moderation reports and snapshots stay (evidence).
  delete from notifications where actor_id = p_subject and kind = 'match_message';
  if coalesce(btrim(v_name), '') <> '' then
    update notifications set body = regexp_replace(body, '\m' || regexp_replace(v_name, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g') || '\M', 'A player', 'g')
     where actor_id = p_subject or body like '%' || v_name || '%' and match_id in (select id from matches where organizer_id = p_subject);
  end if;
  update matches set note = null where organizer_id = p_subject and note is not null;
  get diagnostics n_notes = row_count;
  delete from reports where reporter_id = p_subject and target_kind = 'feedback';

  -- (e) coach listing (no coach bookings, checked above); profile anonymised now in case the sign-in deletion is late
  delete from coaches where profile_id = p_subject;
  -- only the date: the reason is free text written about the person; it is kept (with its retention rule) in the
  -- moderation records, not in this permanent deletion record
  select jsonb_build_object('suspended_at', suspended_at) into susp from account_suspensions where profile_id = p_subject;
  update profiles set name = null, phone = null, level = null, sports = '{}', email_notifications = false where id = p_subject;

  if d.status in ('requested', 'closing', 'closed') then
    update account_deletions set status = 'data_removed', data_removed_at = now(), processed_by = auth.uid(),
      summary = jsonb_build_object('games_cancelled', n_games, 'bookings_cancelled', n_cancelled, 'refunds_due', n_refund,
                                   'bookings_anonymised', n_anon, 'messages_deleted', n_msgs, 'game_notes_cleared', n_notes, 'suspension', susp)
     where id = d.id returning summary into susp;
  else
    update account_deletions set summary = summary || jsonb_build_object('last_rerun', jsonb_build_object('at', now(),
        'games_cancelled', n_games, 'bookings_cancelled', n_cancelled, 'bookings_anonymised', n_anon, 'messages_deleted', n_msgs))
     where id = d.id returning summary into susp;
  end if;
  return susp;
end $function$;
