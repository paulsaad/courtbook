-- The payments dashboard was reporting simulated money as collected.
--
-- Phase 10 added `payments.collected` precisely as the evidence that real money changed hands, and
-- the rule written down with it was that simulated money is never collected. Then neither reporting
-- function used it: both summed every row with status = 'paid'. Since no payment provider is live,
-- every such row on this project is simulated — so the dashboard showed $318.00 "Collected" and told
-- the club it was owed $310.00, when CourtBook holds nothing and owes nothing.
--
-- The data had the distinction all along; the reporting threw it away. So:
--
--   * the money columns count only what was actually collected, and
--   * simulated totals are returned separately, in their own columns, so a screen can show them as
--     what they are. They are never added to the real figures.
--
-- An outstanding balance means CourtBook is holding a club's money. That must never be true of money
-- nobody paid.

drop function if exists payments_summary(date);
create or replace function payments_summary(p_month date)
returns table (club_id uuid, club_name text, bookings int, gross numeric, fees numeric,
               owed_to_club numeric, refunds_due int, refunded numeric,
               simulated_bookings int, simulated_total numeric)
language sql stable security definer set search_path = public as $$
  select c.id, c.name,
         count(*) filter (where p.status = 'paid' and p.collected)::int,
         coalesce(sum(p.total_usd)  filter (where p.status = 'paid' and p.collected), 0),
         coalesce(sum(p.fee_usd)    filter (where p.status = 'paid' and p.collected), 0),
         coalesce(sum(p.amount_usd) filter (where p.status = 'paid' and p.collected), 0),
         count(*) filter (where p.status = 'refund_due')::int,
         coalesce(sum(p.total_usd)  filter (where p.status = 'refunded' and p.collected), 0),
         -- money that was never taken: shown, labelled, and never added to the figures above
         count(*) filter (where p.status = 'paid' and not p.collected)::int,
         coalesce(sum(p.total_usd)  filter (where p.status = 'paid' and not p.collected), 0)
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

drop function if exists club_balances();
create or replace function club_balances()
returns table (club_id uuid, club_name text, club_share numeric, paid_out numeric,
               outstanding numeric, simulated_share numeric)
language sql stable security definer set search_path = public as $$
  select c.id, c.name,
         coalesce((select sum(p.amount_usd) from payments p
                    where p.club_id = c.id and p.status = 'paid' and p.collected), 0),
         coalesce((select sum(o.amount_usd) from club_payouts o where o.club_id = c.id), 0),
         coalesce((select sum(p.amount_usd) from payments p
                    where p.club_id = c.id and p.status = 'paid' and p.collected), 0)
       - coalesce((select sum(o.amount_usd) from club_payouts o where o.club_id = c.id), 0),
         coalesce((select sum(p.amount_usd) from payments p
                    where p.club_id = c.id and p.status = 'paid' and not p.collected), 0)
  from clubs c
  where is_staff_of(c.id)
  order by c.name;
$$;
revoke execute on function club_balances() from public, anon;
grant execute on function club_balances() to authenticated;
