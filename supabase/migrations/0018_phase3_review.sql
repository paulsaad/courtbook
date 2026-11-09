-- Phase 3 review fixes.
-- #1 gateway session reuse: payments.session_ref / session_url persisted by the pay route.
-- #4 no overlapping price rules at the same specificity.
-- #5 club settlements: club_payouts table; outstanding = club share of paid bookings − payouts.
-- #6 refunds_due returns club_id.

alter table payments add column if not exists session_ref text;
alter table payments add column if not exists session_url text;

-- #4 --------------------------------------------------------------------------
create or replace function price_rules_no_overlap() returns trigger
language plpgsql as $$
begin
  if exists (
    select 1 from price_rules r
    where r.club_id = new.club_id
      and r.id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000')
      and r.court_id is not distinct from new.court_id            -- same specificity (club-wide or same court)
      and (r.weekday_mask & new.weekday_mask) <> 0
      and r.start_time < new.end_time and new.start_time < r.end_time
  ) then
    raise exception 'price_rule_overlap';
  end if;
  return new;
end $$;
drop trigger if exists price_rules_overlap_check on price_rules;
create trigger price_rules_overlap_check
  before insert or update on price_rules
  for each row execute function price_rules_no_overlap();

-- #5 --------------------------------------------------------------------------
create table if not exists club_payouts (
  id          uuid primary key default gen_random_uuid(),
  club_id     uuid not null references clubs(id),
  amount_usd  numeric(10,2) not null check (amount_usd > 0),
  paid_at     date not null default current_date,
  method      text,            -- cash, Whish, bank
  reference   text,
  note        text,
  created_by  uuid not null references profiles(id),
  created_at  timestamptz not null default now()
);
alter table club_payouts enable row level security;
create policy "club_payouts: read" on club_payouts for select using (is_staff_of(club_id));
create policy "club_payouts: admin write" on club_payouts for all using (is_admin()) with check (is_admin());

-- all-time club balance: share of paid bookings minus payouts recorded
create or replace function club_balances()
returns table (club_id uuid, club_name text, club_share numeric, paid_out numeric, outstanding numeric)
language sql stable security definer set search_path = public as $$
  select c.id, c.name,
         coalesce((select sum(p.amount_usd) from payments p where p.club_id = c.id and p.status = 'paid'), 0),
         coalesce((select sum(o.amount_usd) from club_payouts o where o.club_id = c.id), 0),
         coalesce((select sum(p.amount_usd) from payments p where p.club_id = c.id and p.status = 'paid'), 0)
       - coalesce((select sum(o.amount_usd) from club_payouts o where o.club_id = c.id), 0)
  from clubs c
  where is_staff_of(c.id)
  order by c.name;
$$;
revoke execute on function club_balances() from public, anon;
grant execute on function club_balances() to authenticated;

-- #6 --------------------------------------------------------------------------
drop function refunds_due();
create or replace function refunds_due()
returns table (payment_id uuid, club_id uuid, club_name text, player_name text, court_name text, start_at timestamptz, total_usd numeric, note text, since timestamptz)
language sql stable security definer set search_path = public as $$
  select p.id, c.id, c.name, pr.name, k.name, b.start_at, p.total_usd, p.note, b.cancelled_at
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
