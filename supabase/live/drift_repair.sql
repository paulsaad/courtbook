-- LIVE drift repair (2026-11-14). Puts back exactly what three repository migrations create and the
-- live database is missing, nothing else:
--   0004  the bookings_slot_validation trigger (only the trigger: 0004's other objects were replaced
--         by later migrations and are already correct on live)
--   0021  "coach_clubs: coach withdraws" also allows withdrawing a 'removed' link
--   0023  availability_exceptions.club_id (+ foreign key), its read policy, coach_availability()
-- All or nothing: it first checks that live is in exactly the state the read-only inspection found,
-- applies the three, then checks the result equals the repository baseline. Any failure rolls back
-- everything. Running it a second time stops at the first check and changes nothing.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $pre$
begin
  if exists (select 1 from pg_trigger where tgname = 'bookings_slot_validation' and tgrelid = 'public.bookings'::regclass) then
    raise exception 'STOPPED, nothing changed: bookings_slot_validation already exists';
  end if;
  if (select left(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g')), 12) from pg_proc
      where oid = 'public.bookings_validate_slot()'::regprocedure) <> '4658300d91e8' then
    raise exception 'STOPPED, nothing changed: bookings_validate_slot() is not the repository version';
  end if;
  if (select qual from pg_policies where schemaname = 'public' and tablename = 'coach_clubs' and policyname = 'coach_clubs: coach withdraws')
     is distinct from '((coach_id = my_coach_id()) AND (status = ANY (ARRAY[''pending''::text, ''declined''::text])))' then
    raise exception 'STOPPED, nothing changed: "coach_clubs: coach withdraws" is not the 0020 version';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'availability_exceptions' and column_name = 'club_id') then
    raise exception 'STOPPED, nothing changed: availability_exceptions.club_id already exists';
  end if;
  if (select left(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g')), 12) from pg_proc
      where oid = 'public.coach_availability(uuid,uuid,date,integer)'::regprocedure) <> '69c35ce7627e' then
    raise exception 'STOPPED, nothing changed: coach_availability() is not the 0022 version';
  end if;
end $pre$;

-- ===== 0004 (the trigger statement only, unchanged) =====
create trigger bookings_slot_validation
  before insert or update of court_id, start_at, end_at on bookings
  for each row execute function bookings_validate_slot();

-- ===== 0021, unchanged =====
-- A coach removed or declined by a club may withdraw that record and request again.
drop policy "coach_clubs: coach withdraws" on coach_clubs;
create policy "coach_clubs: coach withdraws" on coach_clubs for delete
  using (coach_id = my_coach_id() and status in ('pending', 'declined', 'removed'));

-- ===== 0023, unchanged =====
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

do $post$
begin
  if (select pg_get_triggerdef(oid) from pg_trigger where tgname = 'bookings_slot_validation' and tgrelid = 'public.bookings'::regclass)
     is distinct from 'CREATE TRIGGER bookings_slot_validation BEFORE INSERT OR UPDATE OF court_id, start_at, end_at ON public.bookings FOR EACH ROW EXECUTE FUNCTION bookings_validate_slot()' then
    raise exception 'ROLLED BACK: trigger is not the repository version';
  end if;
  if (select qual from pg_policies where schemaname = 'public' and tablename = 'coach_clubs' and policyname = 'coach_clubs: coach withdraws')
     is distinct from '((coach_id = my_coach_id()) AND (status = ANY (ARRAY[''pending''::text, ''declined''::text, ''removed''::text])))' then
    raise exception 'ROLLED BACK: "coach_clubs: coach withdraws" is not the 0021 version';
  end if;
  if (select qual from pg_policies where schemaname = 'public' and tablename = 'availability_exceptions' and policyname = 'avail_exc: read')
     is distinct from '((coach_id = my_coach_id()) OR is_staff_of(club_id) OR coach_listed_at(coach_id, club_id))' then
    raise exception 'ROLLED BACK: "avail_exc: read" is not the 0023 version';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'availability_exceptions'
                 and column_name = 'club_id' and data_type = 'uuid' and is_nullable = 'NO')
     or not exists (select 1 from pg_constraint where conname = 'availability_exceptions_club_id_fkey'
                    and pg_get_constraintdef(oid) = 'FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE') then
    raise exception 'ROLLED BACK: availability_exceptions.club_id is not the 0023 version';
  end if;
  if (select left(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g')), 12) from pg_proc
      where oid = 'public.coach_availability(uuid,uuid,date,integer)'::regprocedure) <> '6f096de16d4c' then
    raise exception 'ROLLED BACK: coach_availability() is not the 0023 version';
  end if;
end $post$;

notify pgrst, 'reload schema';
commit;
select 'drift repaired: trigger restored, 0021 and 0023 applied' as result;
