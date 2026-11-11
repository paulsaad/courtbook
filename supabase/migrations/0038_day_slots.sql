-- Phase 7 (c): Courts day view. For a date, sport and area: every free start time per court, with how many
-- minutes are free from there (capped at the club's maximum). Same rules as the grid: grid-aligned, inside
-- opening hours, at least the minimum booking length, not in the past, not overlapping a live booking or a block.
-- Read-only; public (same exposure as public_occupancy: taken/free only).
create or replace function club_day_slots(p_date date, p_sport sport default null, p_governorate text default null, p_district text default null, p_query text default null)
returns table (
  club_id uuid, club_name text, slug text, town text, district text, price_from numeric, sports sport[],
  slot_minutes int, min_minutes int, max_minutes int, service_fee_usd numeric, hold_minutes int, cancel_cutoff_hours int, timezone text,
  court_id uuid, court_name text, court_sport sport, start_at timestamptz, free_minutes int
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  c record; k record; day0 timestamp; open_min int; close_min int; m int; t timestamptz; run int; q text := nullif(trim(p_query), '');
begin
  for c in
    select cl.*, tw.name_en as town_name, d.name_en as district_name,
           (select min(pr.price_usd) from price_rules pr where pr.club_id = cl.id) as pf
    from clubs cl
    left join towns tw on tw.id = cl.town_id
    left join districts d on d.code = tw.district_code
    left join governorates g on g.code = d.governorate_code
    where cl.active
      and (p_governorate is null or g.code = p_governorate)
      and (p_district is null or d.code = p_district)
      and (q is null or cl.name ilike '%' || q || '%' or tw.name_en ilike '%' || q || '%' or tw.name_ar like '%' || q || '%')
      and p_date >= (now() at time zone cl.timezone)::date
      and p_date <= (now() at time zone cl.timezone)::date + cl.booking_window_days
    order by g.sort_order nulls last, d.sort_order nulls last, cl.name
  loop
    day0 := p_date::timestamp;
    open_min := (extract(epoch from c.open_time) / 60)::int;
    close_min := (extract(epoch from c.close_time) / 60)::int;
    for k in select k0.* from courts k0 where k0.club_id = c.id and k0.active and (p_sport is null or k0.sport = p_sport) order by k0.sort loop
      m := open_min;
      while m + c.min_booking_minutes <= close_min loop
        t := (day0 + make_interval(mins => m)) at time zone c.timezone;
        if t > now() + interval '5 min' then
          -- free run from t, in grid steps, capped at the maximum
          run := 0;
          while m + run + c.slot_minutes <= close_min and run < c.max_booking_minutes loop
            exit when exists (
              select 1 from bookings b where b.court_id = k.id
                and b.start_at < t + make_interval(mins => run + c.slot_minutes) and b.end_at > t + make_interval(mins => run)
                and (b.status = 'confirmed' or (b.status = 'pending' and b.hold_expires_at > now())))
              or exists (
              select 1 from blocks x where x.court_id = k.id
                and x.start_at < t + make_interval(mins => run + c.slot_minutes) and x.end_at > t + make_interval(mins => run));
            run := run + c.slot_minutes;
          end loop;
          if run >= c.min_booking_minutes then
            club_id := c.id; club_name := c.name; slug := c.slug; town := c.town_name; district := c.district_name; price_from := c.pf;
            sports := club_sports(c.id);
            slot_minutes := c.slot_minutes; min_minutes := c.min_booking_minutes; max_minutes := c.max_booking_minutes;
            service_fee_usd := c.service_fee_usd; hold_minutes := c.hold_minutes; cancel_cutoff_hours := c.cancel_cutoff_hours; timezone := c.timezone;
            court_id := k.id; court_name := k.name; court_sport := k.sport; start_at := t; free_minutes := run;
            return next;
          end if;
        end if;
        m := m + c.slot_minutes;
      end loop;
    end loop;
  end loop;
end $$;
revoke execute on function club_day_slots(date, sport, text, text, text) from public;
grant execute on function club_day_slots(date, sport, text, text, text) to anon, authenticated;

-- Coaches directory across clubs (signed-in, like coaches_at_club)
create or replace function coaches_directory(p_governorate text default null, p_district text default null)
returns table (coach_id uuid, name text, sports sport[], levels player_level[], price_usd numeric, whatsapp text, club_id uuid, club_name text, club_slug text, town text)
language sql stable security definer set search_path = public as $$
  select c.id, p.name, c.sports, c.levels, c.price_usd, c.whatsapp, cl.id, cl.name, cl.slug, tw.name_en
  from coaches c
  join profiles p on p.id = c.profile_id
  join coach_clubs cc on cc.coach_id = c.id and cc.status = 'approved'
  join clubs cl on cl.id = cc.club_id and cl.active
  left join towns tw on tw.id = cl.town_id
  left join districts d on d.code = tw.district_code
  where auth.uid() is not null and c.active
    and (p_governorate is null or d.governorate_code = p_governorate)
    and (p_district is null or d.code = p_district)
  order by p.name, cl.name;
$$;
revoke execute on function coaches_directory(text, text) from public, anon;
grant execute on function coaches_directory(text, text) to authenticated;
