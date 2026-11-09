-- Review round 3: three edge cases.
-- #1 no midnight exception: the whole interval must lie within [open_time, close_time] of the
--    start's local day. Clubs closing at midnight use close_time = '24:00' (valid Postgres time).
-- #3 exact seconds: start and duration must be whole minutes, exactly on the grid.
-- #2 staff may not mark their own booking as club-caused.

create or replace function assert_valid_court_slot(p_club uuid, p_court uuid, p_start timestamptz, p_end timestamptz)
returns void
language plpgsql stable set search_path = public as $$
declare
  c clubs%rowtype;
  l_start timestamp;      -- club local time, no tz
  l_end   timestamp;
  day0    timestamp;      -- local midnight of the start day
  start_min int;          -- minutes since day0
  end_min   int;
  dur_s     numeric;
begin
  select * into c from clubs where id = p_club;
  if not found then raise exception 'club_not_found'; end if;
  if not exists (select 1 from courts where id = p_court and club_id = p_club) then
    raise exception 'court_not_found';
  end if;

  l_start := p_start at time zone c.timezone;
  l_end   := p_end   at time zone c.timezone;
  if l_start <> date_trunc('minute', l_start) then raise exception 'not_on_grid'; end if;

  dur_s := extract(epoch from (l_end - l_start));
  if dur_s <= 0 or dur_s % (c.slot_minutes * 60) <> 0 then raise exception 'bad_duration'; end if;

  day0 := date_trunc('day', l_start);
  start_min := (extract(epoch from (l_start - day0)) / 60)::int;
  end_min   := (extract(epoch from (l_end   - day0)) / 60)::int;   -- may exceed 1440 only if it crosses midnight
  if start_min < (extract(epoch from c.open_time) / 60)::int
     or end_min > (extract(epoch from c.close_time) / 60)::int then
    raise exception 'outside_opening_hours';
  end if;
  if (start_min - (extract(epoch from c.open_time) / 60)::int) % c.slot_minutes <> 0 then
    raise exception 'not_on_grid';
  end if;
end $$;

create or replace function cancel_booking(p_booking uuid, p_club_caused boolean default false)
returns void
language plpgsql security definer set search_path = public as $$
declare
  b bookings%rowtype;
  cutoff int;
  is_staff boolean;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  select * into b from bookings where id = p_booking for update;
  if not found then raise exception 'not_found'; end if;
  if b.status <> 'confirmed' then raise exception 'not_confirmed'; end if;

  is_staff := is_staff_of(b.club_id);
  if not is_staff and (b.player_id is null or b.player_id <> auth.uid()) then
    raise exception 'forbidden';
  end if;
  if p_club_caused and (not is_staff or b.player_id = auth.uid()) then
    raise exception 'forbidden';   -- nobody marks their own booking club-caused
  end if;

  select cancel_cutoff_hours into cutoff from clubs where id = b.club_id;

  update bookings set status = 'cancelled', cancelled_at = now() where id = p_booking;

  if b.credit_tx_id is not null
     and (p_club_caused or b.start_at - make_interval(hours => cutoff) > now()) then
    insert into credit_transactions (profile_id, delta, kind, booking_id, created_by, note)
    values (b.player_id, +1, 'refund', b.id, auth.uid(),
            case when p_club_caused then 'club-caused cancellation' else 'cancelled before cutoff' end);
  end if;
end $$;
