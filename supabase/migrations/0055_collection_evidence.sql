-- Fourth review, and both points land. 0054 has already run, so this corrects it forward.
--
-- What went wrong: I used paid_at as the evidence that money was collected, and then backfilled it
-- from created_at wherever a provider_ref existed. Two separate mistakes.
--   a) A simulated provider_ref is not evidence of anything. Simulated money was never collected, so
--      an old simulated refund_due row was handed evidence it had no right to, and desk mode then
--      allowed its refund.
--   b) created_at is when the payment row was made, not when the money arrived. Writing it into
--      paid_at turns "we do not know" into a precise-looking claim.
--
-- The fix is to stop overloading paid_at. `collected` says whether real money was taken; paid_at
-- keeps saying when, and stays null when that is genuinely unknown.

alter table payments add column if not exists collected boolean not null default false;
comment on column payments.collected is
  'Real money was taken for this payment. Simulated payments are never collected. paid_at may be null even when true, for receipts recovered without a reliable time.';

-- Undo 0054's stamp wherever it invented a time. created_at = paid_at on a refund row is that
-- stamp's signature; a real confirmation sets paid_at from now(), after the row was created.
update payments
set paid_at = null,
    note = trim(both ' ·' from coalesce(note, '') || ' · receipt time unknown')
where status in ('refund_due', 'refunded')
  and provider_ref is not null
  and paid_at is not null
  and paid_at = created_at;

-- Real collection, recovered: a gateway reference from a real provider is evidence the money moved.
update payments set collected = true
where provider <> 'simulated' and provider_ref is not null
  and (status in ('paid', 'refund_due', 'refunded'));

-- Everything a real confirmation touches from now on says so explicitly.
create or replace function confirm_payment(p_payment uuid, p_provider_ref text, p_total_usd numeric)
returns text
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
revoke execute on function confirm_payment(uuid, text, numeric) from public, anon, authenticated;
grant execute on function confirm_payment(uuid, text, numeric) to service_role;

-- The guard now reads the flag rather than inferring collection from a timestamp.
create or replace function payments_block_at_desk() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_mode text; v_collected boolean;
begin
  if new.status not in ('pending', 'paid', 'refund_due', 'refunded') then return new; end if;
  v_collected := coalesce(new.collected, false) or coalesce(case when tg_op = 'UPDATE' then old.collected end, false);
  -- real money that was taken can always be given back, however many steps the refund takes
  if new.status in ('refund_due', 'refunded') and v_collected then return new; end if;
  select payment_mode into v_mode from clubs where id = new.club_id for share;
  if v_mode = 'at_desk' then raise exception 'wrong_payment_mode'; end if;
  return new;
end $$;

drop trigger if exists payments_no_money_at_desk on payments;
create trigger payments_no_money_at_desk
  before insert or update of status on payments
  for each row execute function payments_block_at_desk();
