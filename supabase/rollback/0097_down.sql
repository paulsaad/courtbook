-- Rollback of 0097 (draft): restores start_payment_attempt and record_attempt_result exactly as 0094 defined them.
-- Grants are unchanged by 0097 (create or replace keeps them), so nothing else to restore.
begin;
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
commit;
