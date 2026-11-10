-- Phase 4 (simplified, Paul 2026-11-09): coach discovery, not booking.
-- Coach profile → requests listing at clubs → club staff approve → weekly availability per club
-- + one-off exceptions → players browse coaches per club and contact them on WhatsApp.

-- ---------------------------------------------------------------------------
-- coaches: reuse the v0.1 table, drop the admin-approval/club_ids model
-- ---------------------------------------------------------------------------
alter table coaches add column if not exists levels player_level[] not null default '{}';
alter table coaches add column if not exists whatsapp text;            -- shown to players (coach's choice)
alter table coaches add column if not exists active boolean not null default true;   -- coach can pause; admin can block
-- old policies/trigger depend on these columns: drop them first
drop policy if exists "coaches: read approved" on coaches;
drop policy if exists "coaches: apply" on coaches;
drop policy if exists "coaches: edit own" on coaches;
drop policy if exists "coaches: admin delete" on coaches;
drop trigger if exists coaches_protect_approval on coaches;
drop function if exists protect_coach_approval();
alter table coaches drop column if exists club_ids;
alter table coaches drop column if exists approved;

create table coach_clubs (
  coach_id     uuid not null references coaches(id) on delete cascade,
  club_id      uuid not null references clubs(id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'removed')),
  requested_at timestamptz not null default now(),
  decided_at   timestamptz,
  decided_by   uuid references profiles(id),
  primary key (coach_id, club_id)
);

-- availability is per club (a coach's hours differ between clubs)
alter table availability_rules add column club_id uuid references clubs(id) on delete cascade;
delete from availability_rules where club_id is null;
alter table availability_rules alter column club_id set not null;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
drop policy if exists "coaches: read approved" on coaches;
drop policy if exists "coaches: apply" on coaches;
drop policy if exists "coaches: edit own" on coaches;
drop policy if exists "coaches: admin delete" on coaches;

create policy "coaches: read listed or own" on coaches for select using (
  profile_id = auth.uid() or is_admin()
  or (active and exists (select 1 from coach_clubs cc where cc.coach_id = coaches.id and cc.status = 'approved'))
);
create policy "coaches: create own"  on coaches for insert with check (profile_id = auth.uid());
create policy "coaches: edit own"    on coaches for update using (profile_id = auth.uid() or is_admin());
create policy "coaches: admin delete" on coaches for delete using (is_admin());

alter table coach_clubs enable row level security;
create policy "coach_clubs: read" on coach_clubs for select using (
  coach_id = my_coach_id() or is_staff_of(club_id) or status = 'approved'
);
create policy "coach_clubs: coach requests" on coach_clubs for insert with check (coach_id = my_coach_id() and status = 'pending');
create policy "coach_clubs: coach withdraws" on coach_clubs for delete using (coach_id = my_coach_id() and status in ('pending', 'declined'));
create policy "coach_clubs: staff decide" on coach_clubs for update using (is_staff_of(club_id)) with check (is_staff_of(club_id));

-- availability: coach writes own (existing policies reference coach_id = my_coach_id()); readable by all signed-in
-- (existing "avail_rules: read" / "avail_exc: read" policies stay)

-- ---------------------------------------------------------------------------
-- Listing and availability
-- ---------------------------------------------------------------------------
create or replace function coaches_at_club(p_club uuid)
returns table (coach_id uuid, name text, sports sport[], levels player_level[], price_usd numeric, bio text, whatsapp text)
language sql stable security definer set search_path = public as $$
  select c.id, p.name, c.sports, c.levels, c.price_usd, c.bio, c.whatsapp
  from coaches c
  join coach_clubs cc on cc.coach_id = c.id and cc.club_id = p_club and cc.status = 'approved'
  join profiles p on p.id = c.profile_id
  where c.active and auth.uid() is not null
  order by p.name;
$$;
revoke execute on function coaches_at_club(uuid) from public, anon;
grant execute on function coaches_at_club(uuid) to authenticated;

-- One coach, for the coach page (any club they are approved at)
create or replace function coach_card(p_coach uuid)
returns table (coach_id uuid, name text, sports sport[], levels player_level[], price_usd numeric, bio text, whatsapp text,
               clubs jsonb)
language sql stable security definer set search_path = public as $$
  select c.id, p.name, c.sports, c.levels, c.price_usd, c.bio, c.whatsapp,
         coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'name', k.name, 'slug', k.slug, 'timezone', k.timezone) order by k.name)
                   from coach_clubs cc join clubs k on k.id = cc.club_id where cc.coach_id = c.id and cc.status = 'approved'), '[]'::jsonb)
  from coaches c join profiles p on p.id = c.profile_id
  where c.id = p_coach and auth.uid() is not null
    and (c.active and exists (select 1 from coach_clubs cc where cc.coach_id = c.id and cc.status = 'approved') or c.profile_id = auth.uid() or is_admin());
$$;
revoke execute on function coach_card(uuid) from public, anon;
grant execute on function coach_card(uuid) to authenticated;

-- Availability windows for a coach at a club over a date range, in club local time:
-- weekly rules minus "closed" exceptions, plus "open" exceptions. Returned as local date + times.
create or replace function coach_availability(p_coach uuid, p_club uuid, p_from date, p_days int)
returns table (day date, start_time time, end_time time, source text)
language sql stable security definer set search_path = public as $$
  with days as (
    select (p_from + i)::date as day from generate_series(0, least(p_days, 30) - 1) as i
  ),
  closed_days as (
    select date as day from availability_exceptions
    where coach_id = p_coach and available = false and start_time is null
  ),
  closed_ranges as (
    select date as day, start_time, end_time from availability_exceptions
    where coach_id = p_coach and available = false and start_time is not null
  ),
  weekly as (
    select d.day, r.start_time, r.end_time
    from days d
    join availability_rules r on r.coach_id = p_coach and r.club_id = p_club
      and r.weekday = extract(isodow from d.day)::int - 1
    where d.day not in (select day from closed_days)
  ),
  extra as (
    select e.date as day, e.start_time, e.end_time
    from availability_exceptions e join days d on d.day = e.date
    where e.coach_id = p_coach and e.available = true and e.start_time is not null
  )
  select w.day, w.start_time, w.end_time, 'weekly'
  from weekly w
  where not exists (select 1 from closed_ranges c where c.day = w.day and c.start_time < w.end_time and w.start_time < c.end_time)
  union all
  select day, start_time, end_time, 'extra' from extra
  order by 1, 2;
$$;
revoke execute on function coach_availability(uuid, uuid, date, int) from public, anon;
grant execute on function coach_availability(uuid, uuid, date, int) to authenticated;

-- Pending/approved coaches for the staff settings page
create or replace function club_coach_requests(p_club uuid)
returns table (coach_id uuid, name text, sports sport[], price_usd numeric, status text, requested_at timestamptz)
language sql stable security definer set search_path = public as $$
  select c.id, p.name, c.sports, c.price_usd, cc.status, cc.requested_at
  from coach_clubs cc join coaches c on c.id = cc.coach_id join profiles p on p.id = c.profile_id
  where cc.club_id = p_club and is_staff_of(p_club) and cc.status in ('pending', 'approved')
  order by cc.status, cc.requested_at;
$$;
revoke execute on function club_coach_requests(uuid) from public, anon;
grant execute on function club_coach_requests(uuid) to authenticated;

create or replace function decide_coach_club(p_coach uuid, p_club uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not is_staff_of(p_club) then raise exception 'forbidden'; end if;
  update coach_clubs set status = case when p_approve then 'approved' else 'removed' end,
    decided_at = now(), decided_by = auth.uid()
  where coach_id = p_coach and club_id = p_club;
  if not found then raise exception 'not_found'; end if;
end $$;
revoke execute on function decide_coach_club(uuid, uuid, boolean) from public, anon;
grant execute on function decide_coach_club(uuid, uuid, boolean) to authenticated;
