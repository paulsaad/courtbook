-- LOCAL TEST ONLY — never run on live or staging. Turns a database built from 0001–0064 into a
-- replica of the live drift found on 2026-11-14 (diagnose_vs_baseline.sql reproduces all 108 live
-- rows on it), so drift_repair.sql, the preflights and 0065_apply.sql can be tested against it.
begin;
drop trigger bookings_slot_validation on bookings;
revoke execute on function price_rules_no_overlap() from authenticated; revoke execute on function sync_match_with_booking() from authenticated;
drop policy "coach_clubs: coach withdraws" on coach_clubs;
create policy "coach_clubs: coach withdraws" on coach_clubs for delete using (coach_id = my_coach_id() and status in ('pending', 'declined'));
drop policy "avail_exc: read" on availability_exceptions; alter table availability_exceptions drop column club_id;
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

do $$ declare r record; d text; begin
  for r in select p.oid from pg_proc p where p.pronamespace = 'public'::regnamespace
     and not exists (select 1 from pg_depend x where x.classid='pg_proc'::regclass and x.objid=p.oid and x.deptype='e') loop
    d := pg_get_functiondef(r.oid);
    execute replace(d, E'\n', E'\r\n');
  end loop; end $$;
commit;
