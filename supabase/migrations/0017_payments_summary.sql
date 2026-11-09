-- Phase 3 (3): payments dashboard.
-- Monthly summary per club (clubs the caller staffs; admin sees all).
-- Counted as revenue: payments with status 'paid'. Refunded / refund_due are excluded from both
-- fees earned and the amount owed to the club (full refunds only in v0.1).

create or replace function payments_summary(p_month date)
returns table (club_id uuid, club_name text, bookings int, gross numeric, fees numeric, owed_to_club numeric, refunds_due int, refunded numeric)
language sql stable security definer set search_path = public as $$
  select c.id, c.name,
         count(*) filter (where p.status = 'paid')::int,
         coalesce(sum(p.total_usd)  filter (where p.status = 'paid'), 0),
         coalesce(sum(p.fee_usd)    filter (where p.status = 'paid'), 0),
         coalesce(sum(p.amount_usd) filter (where p.status = 'paid'), 0),
         count(*) filter (where p.status = 'refund_due')::int,
         coalesce(sum(p.total_usd)  filter (where p.status = 'refunded'), 0)
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

-- Row list for the dashboard and CSV (clubs the caller staffs)
create or replace function payments_list(p_club uuid, p_month date)
returns table (
  payment_id uuid, booking_id uuid, status payment_status, provider text, provider_ref text,
  player_name text, court_name text, start_at timestamptz, end_at timestamptz,
  amount_usd numeric, fee_usd numeric, total_usd numeric, paid_at timestamptz, refunded_at timestamptz, note text
)
language sql stable security definer set search_path = public as $$
  select p.id, p.booking_id, p.status, p.provider, p.provider_ref,
         pr.name, k.name, b.start_at, b.end_at,
         p.amount_usd, p.fee_usd, p.total_usd, p.paid_at, p.refunded_at, p.note
  from payments p
  join bookings b on b.id = p.booking_id
  left join courts k on k.id = b.court_id
  left join profiles pr on pr.id = p.profile_id
  where p.club_id = p_club and is_staff_of(p_club)
    and (p_month is null or (
      coalesce(p.paid_at, p.created_at) >= date_trunc('month', p_month)
      and coalesce(p.paid_at, p.created_at) < date_trunc('month', p_month) + interval '1 month'))
  order by coalesce(p.paid_at, p.created_at) desc;
$$;
revoke execute on function payments_list(uuid, date) from public, anon;
grant execute on function payments_list(uuid, date) to authenticated;

-- Refunds due across clubs the caller staffs
create or replace function refunds_due()
returns table (payment_id uuid, club_name text, player_name text, court_name text, start_at timestamptz, total_usd numeric, note text, since timestamptz)
language sql stable security definer set search_path = public as $$
  select p.id, c.name, pr.name, k.name, b.start_at, p.total_usd, p.note, b.cancelled_at
  from payments p
  join clubs c on c.id = p.club_id
  join bookings b on b.id = p.booking_id
  left join courts k on k.id = b.court_id
  left join profiles pr on pr.id = p.profile_id
  where p.status = 'refund_due' and is_staff_of(p.club_id)
  order by b.cancelled_at nulls last;
$$;
revoke execute on function refunds_due() from public, anon;
grant execute on function refunds_due() to authenticated;

-- Staff of the club may also mark a refund as executed (they will do it at the desk / via Whish)
create or replace function mark_refunded(p_payment uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_club uuid;
begin
  select club_id into v_club from payments where id = p_payment;
  if v_club is null then raise exception 'not_found'; end if;
  if auth.uid() is not null and not is_staff_of(v_club) then raise exception 'forbidden'; end if;
  update payments set status = 'refunded', refunded_at = now() where id = p_payment and status = 'refund_due';
end $$;
