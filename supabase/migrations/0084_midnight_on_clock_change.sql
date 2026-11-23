-- 0084 — Closing at 24:00 on the spring clock-change night (open issue recorded 21 Nov; checklist M9).
-- The shared slot check (bookings, moves, staff_book, blocks) read an end at that night's midnight as 01:00 next day and
-- refused it as outside_opening_hours. Only clubs closing at 24:00, for 23:00–24:00, once a year. This is the 0078
-- version of assert_valid_court_slot (demo-club guard included) with one added line; it applies after 0078.
CREATE OR REPLACE FUNCTION public.assert_valid_court_slot(p_club uuid, p_court uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  c clubs%rowtype;
  l_start timestamp;      -- club local time, no tz
  l_end   timestamp;
  day0    timestamp;      -- local midnight of the start day
  start_min int;
  end_min   int;
  dur_s     numeric;
begin
  select * into c from clubs where id = p_club;
  if not found then raise exception 'club_not_found'; end if;
  -- 0078: a hidden demo club is not bookable by players (staff, admins and server jobs unaffected)
  if c.is_demo and auth.uid() is not null and not club_visible_to_me(p_club, true) then
    raise exception 'club_not_found';
  end if;
  if not exists (select 1 from courts where id = p_court and club_id = p_club) then
    raise exception 'court_not_found';
  end if;

  dur_s := extract(epoch from (p_end - p_start));            -- real elapsed seconds
  if dur_s <= 0 or dur_s % (c.slot_minutes * 60) <> 0 then raise exception 'bad_duration'; end if;

  l_start := p_start at time zone c.timezone;
  l_end   := p_end   at time zone c.timezone;
  if l_start <> date_trunc('minute', l_start) then raise exception 'not_on_grid'; end if;

  day0 := date_trunc('day', l_start);
  start_min := (extract(epoch from (l_start - day0)) / 60)::int;
  end_min   := (extract(epoch from (l_end   - day0)) / 60)::int;
  -- 0084: an end at the first instant of the next local day is the day's 24:00, also on the night the clocks jump
  -- forward at midnight (Beirut, last Saturday night of March), when local 00:00 does not exist and the next day
  -- starts at 01:00 (read as minute 1500 before this fix, so a 23:00–24:00 booking was refused that night).
  if p_end = ((day0 + interval '1 day') at time zone c.timezone) then end_min := 1440; end if;
  if start_min < (extract(epoch from c.open_time) / 60)::int
     or end_min > (extract(epoch from c.close_time) / 60)::int then
    raise exception 'outside_opening_hours';
  end if;
  if (start_min - (extract(epoch from c.open_time) / 60)::int) % c.slot_minutes <> 0 then
    raise exception 'not_on_grid';
  end if;
end $function$;
