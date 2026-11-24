-- 0089: a club cannot be published without an exact map point (lat/lng), so Nearby and Directions work for every
-- club players can see. Changes one line of 0081's readiness check (the 'location' item); everything else in the
-- function is 0081's text unchanged. Kept separate from 0087/0088 so it can be decided on its own.
-- Already-published clubs are not unpublished: the check runs when a club is published (0081's trigger).

create or replace function club_readiness_rows(p_club uuid)
returns table (item text, ok boolean, detail text)
language plpgsql stable security definer set search_path = public as $$
declare
  c clubs%rowtype;
  n int; gap text; dup text;
  open_min int; close_min int;
begin
  select * into c from clubs where id = p_club;
  if not found then return; end if;
  open_min := (extract(epoch from c.open_time) / 60)::int;
  close_min := (extract(epoch from c.close_time) / 60)::int;     -- 24:00 counts as 1440

  item := 'name'; ok := btrim(c.name) <> ''; detail := null; return next;
  item := 'location'; ok := c.town_id is not null and (nullif(btrim(coalesce(c.address, '')), '') is not null or nullif(btrim(coalesce(c.location_url, '')), '') is not null)
                         and c.lat is not null and c.lng is not null;                                         -- 0089
    detail := case when c.town_id is null then 'choose the town'
                   when c.lat is null or c.lng is null then 'set the exact map point (latitude and longitude)'   -- 0089
                   when ok then null else 'add the address or a map link' end; return next;
  item := 'contact'; ok := c.contact_phone is not null; detail := case when ok then null else 'add a phone number players can call' end; return next;
  item := 'hours'; ok := close_min > open_min and close_min - open_min >= c.min_booking_minutes;
    detail := case when ok then null else 'opening hours are shorter than the shortest booking' end; return next;
  select count(*) into n from courts where club_id = p_club and active;
  item := 'courts'; ok := n > 0; detail := case when ok then n || ' active' else 'add at least one court' end; return next;
  -- every start time on the grid, every weekday, every active court has a price (what quote_price needs)
  select k.name || ', ' || (array['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'])[d + 1] || ' '
         || to_char(make_interval(mins => m), 'HH24:MI'), count(*) over ()
    into gap, n
    from courts k
    cross join generate_series(0, 6) d
    cross join generate_series(open_min, close_min - c.slot_minutes, c.slot_minutes) m
   where k.club_id = p_club and k.active
     and not exists (select 1 from price_rules pr
                      where pr.club_id = p_club and (pr.court_id = k.id or pr.court_id is null)
                        and (pr.weekday_mask & (1 << d)) <> 0
                        and pr.start_time <= make_interval(mins => m)::time
                        and (make_interval(mins => m)::time < pr.end_time))
   order by k.sort, d, m limit 1;
  item := 'prices'; ok := gap is null and exists (select 1 from courts where club_id = p_club and active);
    detail := case when gap is not null then 'no price for ' || gap || case when n > 1 then ' and ' || (n - 1) || ' more start times' else '' end
                   when not ok then 'add courts first' end; return next;
  -- two rules of the same kind (same court, or both club-wide) covering the same weekday and time: which one a booking
  -- gets would be arbitrary
  select coalesce(k.name, 'all courts') || ', ' || to_char(a.start_time, 'HH24:MI') || '–' || to_char(a.end_time, 'HH24:MI')
    into dup
    from price_rules a join price_rules b on b.club_id = a.club_id and b.id > a.id
         and b.court_id is not distinct from a.court_id and (a.weekday_mask & b.weekday_mask) <> 0
         and a.start_time < b.end_time and b.start_time < a.end_time
    left join courts k on k.id = a.court_id
   where a.club_id = p_club limit 1;
  item := 'prices_unambiguous'; ok := dup is null; detail := case when ok then null else 'two prices overlap: ' || dup end; return next;
  select count(*) into n from club_staff where club_id = p_club;
  item := 'staff'; ok := n > 0; detail := case when ok then n || ' assigned' else 'assign at least one desk account' end; return next;
  item := 'payment'; ok := c.payment_mode = 'at_desk' or c.is_demo;
    detail := case when ok then null else 'real clubs take payment at the desk until online payments exist' end; return next;
end $$;
revoke all on function club_readiness_rows(uuid) from public, anon, authenticated;
grant execute on function club_readiness_rows(uuid) to service_role;
