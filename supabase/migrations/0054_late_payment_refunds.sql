-- Third review of the at-the-desk work, and the finding is right.
--
-- The late-payment path is a refund of money that really was collected: the gateway took it, the
-- hold had already expired, and confirm_payment() records it as refund_due. But it left paid_at
-- null, so the rule that protects a desk-mode club from invented obligations — "a refund needs
-- evidence of collection" — blocked the refund from ever being completed.
--
-- The money moved, so paid_at is set when that receipt is recorded. It stays out of revenue because
-- the club's figures count only rows whose status is 'paid', and this row's status is 'refund_due'.

-- confirm_payment, unchanged except that a late receipt records when the money was taken ----------
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
  perform 1 from clubs where id = v_club for share;          -- club → court → booking → payment
  select court_id into v_court from bookings where id = v_booking;

  if v_court is not null then perform 1 from courts where id = v_court for update; end if;
  select * into b from bookings where id = v_booking for update;
  select * into p from payments where id = p_payment for update;

  -- A club settling at its own desk takes nothing through CourtBook, so a simulated confirmation is
  -- never real money and is refused. A real gateway's receipt still lands: it is evidence that money
  -- moved, and refusing it would leave a genuine obligation unrecorded.
  if (select payment_mode from clubs where id = v_club) = 'at_desk' and p.provider = 'simulated' then
    raise exception 'wrong_payment_mode';
  end if;

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
    update bookings set status = 'confirmed', hold_expires_at = null where id = b.id;
    update payments set status = 'paid', paid_at = now(), provider_ref = p_provider_ref where id = p.id;
    return 'confirmed';
  end if;

  -- the gateway took the money after the hold had gone: owed back, and paid_at says it was collected
  update payments set status = 'refund_due', paid_at = now(), provider_ref = p_provider_ref,
    note = 'paid after hold expired or booking cancelled' where id = p.id;
  return 'refund_due';
end $$;
revoke execute on function confirm_payment(uuid, text, numeric) from public, anon, authenticated;
grant execute on function confirm_payment(uuid, text, numeric) to service_role;

-- Rows written by the old version, which are owed back but carry no evidence of collection.
-- A gateway reference is that evidence: it only exists because a gateway confirmed the money.
-- created_at is used rather than now(), so the stamp is close to when it happened instead of
-- claiming the money arrived at migration time.
update payments
set paid_at = created_at
where status in ('refund_due', 'refunded')
  and paid_at is null
  and provider_ref is not null;
