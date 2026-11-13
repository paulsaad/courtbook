-- The demo label has to reach every list a player can browse, not the two I happened to edit.
-- Courts has its own list, from club_day_slots, and it was still showing the fictional club as
-- though it were real until you opened its page.
--
-- Rebuilt from 0039, the live definition — checked with pg_get_functiondef rather than by grepping
-- for the first migration that mentions the function, which is how 0063 nearly reverted public
-- browsing.
drop function if exists club_day_slots(date, sport, text, text, text);
create or replace function club_day_slots(p_date date, p_sport sport default null, p_governorate text default null, p_district text default null, p_query text default null)
returns table (
  club_id uuid, club_name text, slug text, town text, district text, price_from numeric, sports sport[],
  slot_minutes int, min_minutes int, max_minutes int, service_fee_usd numeric, hold_minutes int, cancel_cutoff_hours int, timezone text,
  court_id uuid, court_name text, court_sport sport, start_at timestamptz, free_minutes int, is_demo boolean
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
        -- same window as hold_slot: start must be <= now() + booking_window_days (rolling, not whole-day)
        if t > now() + interval '5 min' and t <= now() + make_interval(days => c.booking_window_days) then
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
            is_demo := c.is_demo;
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

-- `other` was too broad. It is a generic slug, the production seed never creates it, and a real
-- club taking that slug would have been labelled fictional by a migration nobody would think to
-- look at. Only the club that is actually the demo is marked, and this clears the label from any
-- club that an earlier run of 0063 caught by that slug.
--
-- Unconditionally. An earlier draft spared clubs whose name contained "demo", which was a hedge that
-- created the very problem it was meant to avoid: a real club called something like "Demo Sports
-- Centre" would have kept a label saying it does not exist. Nothing marks a club fictional except
-- being the demo club.
update clubs set is_demo = false where slug = 'other';
