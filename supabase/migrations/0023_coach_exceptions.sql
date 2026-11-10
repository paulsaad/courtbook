-- Phase 4 review #3/#4: exceptions are per club; closed ranges split weekly windows instead of removing them.

alter table availability_exceptions add column if not exists club_id uuid references clubs(id) on delete cascade;
-- preserve existing exceptions where the club is unambiguous (coach approved at exactly one club)
update availability_exceptions e set club_id = one.club_id
from (
  select coach_id, min(club_id::text)::uuid as club_id
  from coach_clubs where status = 'approved' group by coach_id having count(*) = 1
) one
where e.club_id is null and e.coach_id = one.coach_id;
-- multi-club or unlisted coaches: no safe assignment; dropped (demo data; re-enter per club)
delete from availability_exceptions where club_id is null;
alter table availability_exceptions alter column club_id set not null;

drop policy if exists "avail_exc: read" on availability_exceptions;
create policy "avail_exc: read" on availability_exceptions for select using (
  coach_id = my_coach_id() or is_staff_of(club_id) or coach_listed_at(coach_id, club_id)
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
    select date as day from availability_exceptions
    where coach_id = p_coach and club_id = p_club and available = false and start_time is null
  ),
  closed_ranges as (
    select date as day, start_time as s, end_time as e from availability_exceptions
    where coach_id = p_coach and club_id = p_club and available = false and start_time is not null
  ),
  -- weekly windows + extra-hours exceptions, on days that are not fully closed
  windows as (
    select d.day, r.start_time as s, r.end_time as e, 'weekly'::text as src
    from days d join availability_rules r on r.coach_id = p_coach and r.club_id = p_club and r.weekday = extract(isodow from d.day)::int - 1
    where d.day not in (select day from closed_days)
    union all
    select x.date, x.start_time, x.end_time, 'extra'
    from availability_exceptions x join days d on d.day = x.date
    where x.coach_id = p_coach and x.club_id = p_club and x.available = true and x.start_time is not null
      and x.date not in (select day from closed_days)
  ),
  -- split each window at the boundaries of closed ranges on the same day
  bounds as (
    select w.day, w.s, w.e, w.src, b.t
    from windows w
    cross join lateral (
      select w.s as t union select w.e
      union select c.s from closed_ranges c where c.day = w.day and c.s > w.s and c.s < w.e
      union select c.e from closed_ranges c where c.day = w.day and c.e > w.s and c.e < w.e
    ) b
  ),
  segments as (
    select day, s, e, src, t as seg_start, lead(t) over (partition by day, s, e, src order by t) as seg_end
    from bounds
  )
  select sg.day, sg.seg_start, sg.seg_end, sg.src
  from segments sg, allowed a
  where a.ok and sg.seg_end is not null
    and not exists (select 1 from closed_ranges c where c.day = sg.day and c.s < sg.seg_end and sg.seg_start < c.e)
  order by 1, 2;
$$;
