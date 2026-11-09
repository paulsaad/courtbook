-- Review round 4: duration must be real elapsed time (timestamptz difference), not local
-- wall-clock difference, which is off by an hour across a DST transition. Opening hours and
-- grid alignment keep using club local time.

create or replace function assert_valid_court_slot(p_club uuid, p_court uuid, p_start timestamptz, p_end timestamptz)
returns void
language plpgsql stable set search_path = public as $$
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
  if start_min < (extract(epoch from c.open_time) / 60)::int
     or end_min > (extract(epoch from c.close_time) / 60)::int then
    raise exception 'outside_opening_hours';
  end if;
  if (start_min - (extract(epoch from c.open_time) / 60)::int) % c.slot_minutes <> 0 then
    raise exception 'not_on_grid';
  end if;
end $$;
