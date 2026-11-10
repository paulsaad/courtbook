-- Phase 4 review round 1.
-- #1 availability readable only where the coach is listed (approved + active) at that club,
--    or by the coach / that club's staff. coach_availability() enforces the same.
-- #2 staff decide only via decide_coach_club(); approve only a pending request.

create or replace function coach_listed_at(p_coach uuid, p_club uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from coach_clubs cc join coaches c on c.id = cc.coach_id
    where cc.coach_id = p_coach and cc.club_id = p_club and cc.status = 'approved' and c.active
  );
$$;
revoke execute on function coach_listed_at(uuid, uuid) from public, anon;
grant execute on function coach_listed_at(uuid, uuid) to authenticated;

drop policy if exists "avail_rules: read" on availability_rules;
create policy "avail_rules: read" on availability_rules for select using (
  coach_id = my_coach_id() or is_staff_of(club_id) or coach_listed_at(coach_id, club_id)
);

drop policy if exists "avail_exc: read" on availability_exceptions;
create policy "avail_exc: read" on availability_exceptions for select using (
  coach_id = my_coach_id() or is_admin()
  or exists (select 1 from coach_clubs cc where cc.coach_id = availability_exceptions.coach_id and cc.status = 'approved'
             and (is_staff_of(cc.club_id) or coach_listed_at(cc.coach_id, cc.club_id)))
);

create or replace function coach_availability(p_coach uuid, p_club uuid, p_from date, p_days int)
returns table (day date, start_time time, end_time time, source text)
language sql stable security definer set search_path = public as $$
  with allowed as (
    select (auth.uid() is not null and (coach_listed_at(p_coach, p_club) or is_staff_of(p_club)
            or exists (select 1 from coaches c where c.id = p_coach and c.profile_id = auth.uid()))) as ok
  ),
  days as (
    select (p_from + i)::date as day from generate_series(0, least(p_days, 30) - 1) as i
  ),
  closed_days as (
    select date as day from availability_exceptions where coach_id = p_coach and available = false and start_time is null
  ),
  closed_ranges as (
    select date as day, start_time, end_time from availability_exceptions where coach_id = p_coach and available = false and start_time is not null
  ),
  weekly as (
    select d.day, r.start_time, r.end_time
    from days d join availability_rules r on r.coach_id = p_coach and r.club_id = p_club and r.weekday = extract(isodow from d.day)::int - 1
    where d.day not in (select day from closed_days)
  ),
  extra as (
    select e.date as day, e.start_time, e.end_time
    from availability_exceptions e join days d on d.day = e.date
    where e.coach_id = p_coach and e.available = true and e.start_time is not null
  )
  select w.day, w.start_time, w.end_time, 'weekly'
  from weekly w, allowed a
  where a.ok and not exists (select 1 from closed_ranges c where c.day = w.day and c.start_time < w.end_time and w.start_time < c.end_time)
  union all
  select x.day, x.start_time, x.end_time, 'extra' from extra x, allowed a where a.ok
  order by 1, 2;
$$;

-- #2
drop policy if exists "coach_clubs: staff decide" on coach_clubs;

create or replace function decide_coach_club(p_coach uuid, p_club uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public as $$
declare cur text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not is_staff_of(p_club) then raise exception 'forbidden'; end if;
  select status into cur from coach_clubs where coach_id = p_coach and club_id = p_club for update;
  if cur is null then raise exception 'not_found'; end if;
  if p_approve then
    if cur <> 'pending' then raise exception 'not_pending'; end if;
    update coach_clubs set status = 'approved', decided_at = now(), decided_by = auth.uid() where coach_id = p_coach and club_id = p_club;
  else
    if cur not in ('pending', 'approved') then raise exception 'not_active'; end if;
    update coach_clubs set status = case when cur = 'pending' then 'declined' else 'removed' end, decided_at = now(), decided_by = auth.uid()
    where coach_id = p_coach and club_id = p_club;
  end if;
end $$;
