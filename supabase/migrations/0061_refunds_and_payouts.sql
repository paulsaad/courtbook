-- Two gaps left by 0060, both the same mistake in different places: `collected` decides whether
-- money is real, and only the revenue figures were taught that.
--
-- 1. REFUNDS. cancel_booking marks any paid payment 'refund_due' without asking whether the money
--    was ever taken, so the refund queue and the "2 refunds due" badge were listing simulated
--    payments as obligations to players. mark_refunded would then happily record a refund of money
--    nobody paid.
--
--    The booking-side status stays as it is: 'refund_due' is the truth about the booking, and
--    rewriting the cancel path would churn a function that many checks depend on. What changes is
--    that `collected` decides what counts as an obligation — the queue lists only real ones, the
--    badge counts only real ones, simulated ones are reported separately, and a refund cannot be
--    recorded against money that was never collected.
--
-- 2. PAYOUTS. The payout form wrote straight into club_payouts from the browser:
--
--        supabase.from("club_payouts").insert({ club_id, amount_usd, created_by: user.id, ... })
--
--    No server-side validation of any kind — the amount was unchecked, and the client supplied
--    created_by. An admin could record paying a club $500 it was never owed, and could do it
--    against a club holding nothing but simulated bookings.
--
--    Payouts now go through a function that locks the club, works out what is actually available
--    from collected money, and refuses anything beyond it. Direct writes are revoked.
--
--    Existing negative balances are left exactly as they are. They are the record of money that
--    already left and must stay visible for reconciliation; this only stops new ones being created.

-- 1 ----------------------------------------------------------------------------------------------
drop function if exists payments_summary(date);
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
         -- only money that was taken can be owed back
         count(*) filter (where p.status = 'refund_due' and p.collected)::int,
         coalesce(sum(p.total_usd)  filter (where p.status = 'refunded' and p.collected), 0),
         count(*) filter (where p.status = 'paid' and not p.collected)::int,
         coalesce(sum(p.total_usd)  filter (where p.status = 'paid' and not p.collected), 0),
         count(*) filter (where p.status = 'refund_due' and not p.collected)::int
  from clubs c
  left join payments p on p.club_id = c.id
    and p.paid_at >= date_trunc('month', p_month)
    and p.paid_at <  date_trunc('month', p_month) + interval '1 month'
  where is_staff_of(c.id)
  group by c.id, c.name
  order by c.name;
$$;
revoke execute on function payments_summary(date) from public, anon;
grant execute on function payments_summary(date) to authenticated;

-- The work queue: a list of people actually owed money.
create or replace function refunds_due()
returns table (payment_id uuid, club_id uuid, club_name text, player_name text, court_name text,
               start_at timestamptz, total_usd numeric, note text, since timestamptz)
language sql stable security definer set search_path = public as $$
  select p.id, c.id, c.name, pr.name, k.name, b.start_at, p.total_usd, p.note, b.cancelled_at
  from payments p
  join clubs c on c.id = p.club_id
  join bookings b on b.id = p.booking_id
  left join courts k on k.id = b.court_id
  left join profiles pr on pr.id = p.profile_id
  where p.status = 'refund_due' and p.collected and is_staff_of(p.club_id)
  order by b.cancelled_at nulls last;
$$;
revoke execute on function refunds_due() from public, anon;
grant execute on function refunds_due() to authenticated;

-- A refund cannot be recorded against money that was never taken.
create or replace function mark_refunded(p_payment uuid) returns void
language plpgsql security definer set search_path = public as $$
declare p payments%rowtype;
begin
  if auth.uid() is not null and not is_admin() then raise exception 'forbidden'; end if;
  select * into p from payments where id = p_payment for update;
  if not found then raise exception 'not_found'; end if;
  if p.status <> 'refund_due' then raise exception 'not_refund_due'; end if;
  if not p.collected then raise exception 'never_collected'; end if;
  update payments set status = 'refunded', refunded_at = now() where id = p_payment;
end $$;
revoke execute on function mark_refunded(uuid) from public, anon;
grant execute on function mark_refunded(uuid) to authenticated, service_role;

-- 2 ----------------------------------------------------------------------------------------------
create or replace function record_club_payout(
  p_club uuid, p_amount numeric, p_method text, p_reference text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_available numeric; v_id uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not is_admin() then raise exception 'forbidden'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'bad_amount'; end if;
  if p_method is null or p_method not in ('Whish', 'Cash', 'Bank') then raise exception 'bad_method'; end if;

  perform 1 from clubs where id = p_club for update;          -- club first, as everywhere else
  if not found then raise exception 'not_found'; end if;

  -- what is genuinely available: money collected for this club, less what has already gone out
  select coalesce((select sum(p.amount_usd) from payments p
                    where p.club_id = p_club and p.status = 'paid' and p.collected), 0)
       - coalesce((select sum(o.amount_usd) from club_payouts o where o.club_id = p_club), 0)
    into v_available;

  if p_amount > v_available then raise exception 'exceeds_balance'; end if;

  insert into club_payouts (club_id, amount_usd, method, reference, created_by)
  values (p_club, p_amount, p_method, nullif(btrim(coalesce(p_reference, '')), ''), auth.uid())
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function record_club_payout(uuid, numeric, text, text) from public, anon;
grant execute on function record_club_payout(uuid, numeric, text, text) to authenticated;

-- Close the direct path. Reading stays; writing goes through the function above, which is the only
-- thing that knows what a club is actually owed.
drop policy if exists "club_payouts: admin write" on club_payouts;
create policy "club_payouts: admin read" on club_payouts for select using (is_staff_of(club_id));
revoke insert, update, delete on club_payouts from authenticated, anon;
