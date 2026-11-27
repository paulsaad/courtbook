-- 0098 (draft, M12 only; isolated branch, never on the pilot line): M1–M3 of the independent M12 review (26 Nov),
-- with Paul's decisions of 26 Nov ("handover: M12 decisions M1–M3 and regression cases"). Applied nowhere; real
-- payments stay off.
--
-- M1 (blocker). A closed attempt is never revived by a late payment; a charge discovered after it creates a refund
--    obligation. record_attempt_result now confirms only when ALL of these hold, on CourtBook's own state only:
--      the attempt is still unresolved ('starting'/'open'); the payment and the hold still wait ('pending'); the
--      deadline the attempt was started under (payment_attempts.hold_deadline, recorded by start_payment_attempt; a
--      hold extended later never stretches it) has not passed; the court time has not begun.
--    Otherwise the charge is recorded and owed back ('late', 'not_confirmed'), and a hold past its deadline or its
--    court time is set 'expired' so the slot is visibly free. A late charge on a closed attempt while the same hold is
--    still live (another attempt may yet pay it) only creates the refund obligation. Provider timestamps are not used
--    (case 3a, optional, not built): without trustworthy timing evidence the outcome is the refund obligation.
--    Every terminal attempt records why it ended (end_reason): provider_failed, provider_expired, unknown_timeout
--    (CourtBook's own inference after the provider never knew it: record_attempt_result(..., 'unknown_timeout')),
--    abandoned. The website and the app say "no fee was taken" only for provider_failed / provider_expired / abandoned.
-- M2. release_hold returns what happened: 'released' | 'already_confirmed' (the payment had confirmed it: the court is
--    booked) | 'already_closed'. It never answers a confirmed booking as released. (Return type: was void; an older
--    client that ignores the answer keeps working.)
-- M3. A club-caused cancellation that turns a kept fee into a CourtBook refund obligation records the signed-in staff
--    member and the time on the charge (fee_charges.club_cancel_by / club_cancel_at). Admin-readable (the table's
--    existing policy), not writable through the API (no grant), immutable once set (trigger, also for the server key).
--    No foreign key: like the moderation log, the record outlives the account (decision: kept, not set null).
-- Case 6 open point: the same provider reference presented again WITHOUT our attempt reference, with the same amount
--    and currency, is 'already_recorded' (a charge list that omits the reference does not fail every run); a different
--    amount or currency stays 'charge_evidence_conflict'.
-- Lock order unchanged everywhere: club (share) → court → booking → payment → payment_attempts → fee_charges.

-- ------------------------------------------------------------------ data
alter table payment_attempts add column if not exists hold_deadline timestamptz;
alter table payment_attempts add column if not exists end_reason text;
alter table payment_attempts drop constraint if exists payment_attempts_end_reason_check;
alter table payment_attempts add constraint payment_attempts_end_reason_check
  check (end_reason is null or end_reason in ('provider_failed', 'provider_expired', 'unknown_timeout', 'abandoned'));
-- attempts that ended before 0098 (local tests only): what their status said
update payment_attempts set end_reason = case status when 'failed' then 'provider_failed' else 'provider_expired' end
where status in ('failed', 'expired') and end_reason is null;
alter table payment_attempts drop constraint if exists payment_attempts_end_reason_terminal;
alter table payment_attempts add constraint payment_attempts_end_reason_terminal
  -- a closed attempt always says why; one that was closed and later shown to have taken money ('succeeded', 'late')
  -- keeps the reason it had been closed for
  check (status not in ('failed', 'expired') or end_reason is not null);

alter table fee_charges add column if not exists club_cancel_by uuid;     -- no FK: the record outlives the account
alter table fee_charges add column if not exists club_cancel_at timestamptz;
alter table fee_charges drop constraint if exists fee_charges_club_cancel_shape;
alter table fee_charges add constraint fee_charges_club_cancel_shape
  check (club_cancel_at is null or reason = 'club_cancelled');
create or replace function fee_charges_club_cancel_immutable() returns trigger
language plpgsql as $$
begin
  if (old.club_cancel_by is not null or old.club_cancel_at is not null)
     and (new.club_cancel_by is distinct from old.club_cancel_by or new.club_cancel_at is distinct from old.club_cancel_at) then
    raise exception 'club_cancel_record_immutable';
  end if;
  return new;
end $$;
revoke all on function fee_charges_club_cancel_immutable() from public, anon, authenticated;
drop trigger if exists fee_charges_club_cancel_immutable on fee_charges;
create trigger fee_charges_club_cancel_immutable before update on fee_charges
  for each row execute function fee_charges_club_cancel_immutable();

-- ------------------------------------------------------------------ M1: start, record, abandon
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
  -- 0097: a closing or closed account starts no new payment (its open holds are cancelled by the data step)
  if deletion_requested(v_player) then raise exception 'account_closed'; end if;

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

  -- 0098 (M1): the attempt keeps the deadline it was started under; a hold extended later never stretches it
  insert into payment_attempts (payment_id, club_id, attempt_no, request_key, provider, amount_usd, currency, hold_deadline)
  values (p.id, p.club_id, v_n + 1, p_request, p.provider, p.total_usd, p.currency, b.hold_expires_at)
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
  v_deadline timestamptz;
  v_live boolean;
  v_closed boolean := false;
begin
  -- 0098: 'unknown_timeout' = CourtBook's own inference (the provider never knew the attempt for UNKNOWN_GRACE_MINUTES),
  -- recorded as expired with that reason, so the player is never told "no fee was taken" on it
  if p_result is null or p_result not in ('succeeded', 'failed', 'expired', 'unknown_timeout', 'pending') then raise exception 'bad_result'; end if;
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

  if p_result in ('failed', 'expired', 'unknown_timeout') then
    -- ends the attempt only: the hold stays until its deadline or until the player releases it
    if a.status in ('starting', 'open') then
      update payment_attempts set status = case when p_result = 'failed' then 'failed' else 'expired' end,
             end_reason = case p_result when 'failed' then 'provider_failed' when 'expired' then 'provider_expired' else 'unknown_timeout' end,
             finished_at = now(), last_checked_at = now(), checks = checks + 1 where id = a.id;
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
  -- 0098 (M1, Paul 26 Nov): CourtBook's own state decides; provider times are never needed and never trusted here.
  -- Confirmed only if the attempt is still unresolved, the payment and the hold still wait, the deadline the attempt was
  -- started under has not passed, and the court time has not begun. Anything else is recorded and owed back.
  -- the earlier of the deadline the attempt was started under and the hold's own (a hold extended later never
  -- stretches it; least() ignores a missing one)
  v_deadline := least(a.hold_deadline, b.hold_expires_at);
  v_live := p.status = 'pending' and b.status = 'pending' and b.start_at > now()
            and v_deadline is not null and now() <= v_deadline;
  if v_currency <> a.currency then v_outcome := 'wrong_currency'; v_reason := 'wrong_currency';
  elsif p_amount <> a.amount_usd then v_outcome := 'wrong_amount'; v_reason := 'wrong_amount';
  elsif p.status = 'paid' then v_outcome := 'duplicate'; v_reason := 'duplicate';
  elsif a.status in ('failed', 'expired') then
    -- 0098 (M1 rule 1): CourtBook had closed this attempt; that is final. The charge is owed back, whenever the provider
    -- says it was taken; the booking is never revived by it
    v_outcome := 'late'; v_reason := 'not_confirmed'; v_closed := true;
    v_note := 'paid after the attempt was closed (' || coalesce(a.end_reason, a.status) || ')';
  elsif p.status = 'pending' and b.status = 'pending' and deletion_requested(b.player_id) then
    -- 0097: money taken after the player closed their account. The account is being deleted, so the booking is never
    -- confirmed for it; the charge is recorded and owed back, as for any success after the hold ended. (Read without
    -- locking the profile: hold_slot takes profile → court, this path court → profile would invert it. A closure that
    -- commits after this check is the same as closing right after paying: the data step cancels the booking, D1.)
    v_outcome := 'late'; v_reason := 'not_confirmed'; v_note := 'paid after the account was closed';
  elsif p.status = 'pending' and b.status = 'pending' and b.start_at <= now() then
    -- 0098 (M1): never confirm a slot whose time has begun
    v_outcome := 'late'; v_reason := 'not_confirmed'; v_note := 'paid after the court time had begun';
  elsif p.status = 'pending' and b.status = 'pending' and not v_live then
    -- 0098 (M1 rule 2): discovered after the deadline the attempt was started under. Without trustworthy provider timing
    -- (none is recorded) the conservative outcome: owed back. Discovery time is never taken as the charge time.
    v_outcome := 'late'; v_reason := 'not_confirmed'; v_note := 'paid after the hold deadline';
  elsif v_live then v_outcome := 'confirmed';
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
  -- 0098: a late charge on an attempt CourtBook had closed, while the same hold is still live (another attempt may yet
  -- pay it): only the charge is owed back; the hold, its payment and the other attempt are left alone
  if v_outcome = 'late' and v_closed and v_live and not deletion_requested(b.player_id) then
    return v_outcome;
  end if;
  -- 0098 (M1): a hold past its deadline or its court time is ended, so the slot is visibly free (it was only waiting for
  -- someone to touch the court: expire_stale_holds). The 0097 closed-account case is left to the data step, as before.
  if v_outcome = 'late' and not v_live and b.status = 'pending' and not deletion_requested(b.player_id) then
    update bookings set status = 'expired' where id = b.id and status = 'pending';
  end if;
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

revoke all on function start_payment_attempt(uuid, uuid) from public, anon;
grant execute on function start_payment_attempt(uuid, uuid) to authenticated;
revoke all on function record_attempt_result(uuid, text, text, numeric, text) from public, anon, authenticated;
grant execute on function record_attempt_result(uuid, text, text, numeric, text) to service_role;

create or replace function abandon_payment_attempt(p_attempt uuid, p_note text)
returns text language plpgsql security definer set search_path = public as $$
declare v_status text;
begin
  update payment_attempts set status = 'failed', end_reason = 'abandoned', finished_at = now(), note = left(p_note, 200)
  where id = p_attempt and status = 'starting'
  returning status into v_status;
  if v_status is null then
    select status into v_status from payment_attempts where id = p_attempt;
    if v_status is null then raise exception 'attempt_not_found'; end if;
  end if;
  return v_status;
end $$;
revoke all on function abandon_payment_attempt(uuid, text) from public, anon, authenticated;
grant execute on function abandon_payment_attempt(uuid, text) to service_role;

-- ------------------------------------------------------------------ M2: release says what happened
drop function if exists release_hold(uuid);
create function release_hold(p_booking uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_court uuid; b bookings%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select court_id into v_court from bookings where id = p_booking and player_id = auth.uid();
  if v_court is null then raise exception 'forbidden'; end if;
  perform 1 from courts where id = v_court for update;
  select * into b from bookings where id = p_booking for update;
  perform 1 from payments where booking_id = p_booking for update;
  if b.status = 'confirmed' then return 'already_confirmed'; end if;   -- the payment won: the court is booked
  if b.status <> 'pending' then return 'already_closed'; end if;
  update bookings set status = 'expired' where id = p_booking;
  update payments set status = 'expired' where booking_id = p_booking and status = 'pending';
  return 'released';   -- an attempt still unresolved stays so: if it later succeeds, the charge is owed back (M1)
end $$;
revoke all on function release_hold(uuid) from public, anon;
grant execute on function release_hold(uuid) to authenticated;

-- ------------------------------------------------------------------ M3: the club-caused refund obligation names its actor
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
    -- 0098 (M3): who chose "the club is cancelling" (the signed-in staff member), and when
    update fee_charges set disposition = 'refund_due', reason = 'club_cancelled', refund_due_at = now(),
           club_cancel_by = auth.uid(), club_cancel_at = now()
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

-- ------------------------------------------------------------------ case 6: reconciliation without our reference
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
  -- 0098 (case 6): the provider's list shows a charge we already recorded but without our reference: the same money,
  -- if amount and currency agree (any other difference is still a conflict, below)
  if v_attempt is null and exists (select 1 from fee_charges where provider = p_provider and provider_ref = v_ref
                                     and amount = p_amount and currency = v_currency) then
    return 'already_recorded';
  end if;
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

revoke all on function reconcile_provider_charge(text, text, text, numeric, text) from public, anon, authenticated;
grant execute on function reconcile_provider_charge(text, text, text, numeric, text) to service_role;
