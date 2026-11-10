-- Phase 6 (b): read-only discovery RPCs for Home. No booking logic touched.

-- First free grid slot today (club local time) for a sport: the earliest start >= now (+5 min lead)
-- where one active court of that sport is free for the club's minimum booking length.
create or replace function next_free_slot(p_club uuid, p_sport sport default null)
returns table (start_at timestamptz, court_id uuid, court_name text)
language plpgsql stable security definer set search_path = public as $$
declare
  c clubs%rowtype; l_now timestamp; day0 timestamp; open_min int; close_min int; m int; t timestamptz; t_end timestamptz; r record;
begin
  if auth.uid() is null then return; end if;
  select * into c from clubs where id = p_club and active;
  if not found then return; end if;
  l_now := now() at time zone c.timezone;
  day0 := date_trunc('day', l_now);
  open_min := (extract(epoch from c.open_time) / 60)::int;
  close_min := (extract(epoch from c.close_time) / 60)::int;
  m := open_min + (ceil(greatest(0, extract(epoch from (l_now - day0)) / 60 + 5 - open_min) / c.slot_minutes))::int * c.slot_minutes;
  while m + c.min_booking_minutes <= close_min loop
    t := (day0 + make_interval(mins => m)) at time zone c.timezone;
    t_end := t + make_interval(mins => c.min_booking_minutes);
    for r in select k.id, k.name from courts k where k.club_id = p_club and k.active and (p_sport is null or k.sport = p_sport) order by k.sort loop
      if not exists (select 1 from bookings b where b.court_id = r.id and b.start_at < t_end and b.end_at > t
                       and (b.status = 'confirmed' or (b.status = 'pending' and b.hold_expires_at > now())))
         and not exists (select 1 from blocks x where x.court_id = r.id and x.start_at < t_end and x.end_at > t) then
        start_at := t; court_id := r.id; court_name := r.name;
        return next; return;
      end if;
    end loop;
    m := m + c.slot_minutes;
  end loop;
end $$;
revoke execute on function next_free_slot(uuid, sport) from public, anon;
grant execute on function next_free_slot(uuid, sport) to authenticated;

-- Clubs for Home: filter by sport / governorate / district / free-text (club or town name, EN or AR).
create or replace function club_discovery(p_sport sport default null, p_governorate text default null, p_district text default null, p_query text default null)
returns table (
  club_id uuid, name text, slug text, town text, district text, governorate text, district_code text, governorate_code text,
  sports sport[], price_from numeric, next_free_at timestamptz, next_free_court text, cover_url text, location_url text,
  open_time time, close_time time
)
language sql stable security definer set search_path = public as $$
  with q as (select nullif(trim(p_query), '') as text)
  select c.id, c.name, c.slug, t.name_en, d.name_en, g.name_en, d.code, g.code,
         club_sports(c.id),
         (select min(pr.price_usd) from price_rules pr
           where pr.club_id = c.id
             and (pr.court_id is null or exists (select 1 from courts k where k.id = pr.court_id and k.active and (p_sport is null or k.sport = p_sport)))),
         nf.start_at, nf.court_name, c.cover_url, c.location_url, c.open_time, c.close_time
  from clubs c
  left join towns t on t.id = c.town_id
  left join districts d on d.code = t.district_code
  left join governorates g on g.code = d.governorate_code
  left join lateral next_free_slot(c.id, p_sport) nf on true
  cross join q
  where auth.uid() is not null and c.active
    and (p_sport is null or exists (select 1 from courts k where k.club_id = c.id and k.active and k.sport = p_sport))
    and (p_governorate is null or g.code = p_governorate)
    and (p_district is null or d.code = p_district)
    and (q.text is null or c.name ilike '%' || q.text || '%' or t.name_en ilike '%' || q.text || '%' or t.name_ar like '%' || q.text || '%')
  order by (nf.start_at is null), g.sort_order nulls last, d.sort_order nulls last, c.name
  limit 100;
$$;
revoke execute on function club_discovery(sport, text, text, text) from public, anon;
grant execute on function club_discovery(sport, text, text, text) to authenticated;

-- Open matches across clubs (others' matches with spots left), for Home and the Play tab.
create or replace function open_matches(
  p_sport sport default null, p_level player_level default null, p_from timestamptz default null, p_to timestamptz default null,
  p_governorate text default null, p_district text default null, p_limit int default 50
)
returns table (
  match_id uuid, club_id uuid, club_name text, club_slug text, town text, sport sport, start_at timestamptz, end_at timestamptz,
  level player_level, players_needed int, joined int, note text, organizer_name text, join_mode text, i_joined boolean, booking_id uuid, court_name text
)
language sql stable security definer set search_path = public as $$
  select m.id, m.club_id, c.name, c.slug, t.name_en, m.sport, m.start_at, m.end_at, m.level, m.players_needed,
         (select count(*) from match_players mp where mp.match_id = m.id and mp.status = 'accepted')::int,
         m.note, o.name, m.join_mode,
         exists (select 1 from match_players mp where mp.match_id = m.id and mp.profile_id = auth.uid() and mp.status in ('accepted', 'pending')),
         m.booking_id, k.name
  from matches m
  join clubs c on c.id = m.club_id
  left join towns t on t.id = c.town_id
  left join districts d on d.code = t.district_code
  left join profiles o on o.id = m.organizer_id
  left join bookings b on b.id = m.booking_id
  left join courts k on k.id = b.court_id
  where auth.uid() is not null and m.status = 'open' and m.organizer_id <> auth.uid()
    and m.start_at > coalesce(p_from, now()) and m.start_at < coalesce(p_to, now() + interval '14 days')
    and (p_sport is null or m.sport = p_sport)
    and (p_level is null or m.level is null or m.level = p_level)
    and (p_governorate is null or d.governorate_code = p_governorate)
    and (p_district is null or d.code = p_district)
  order by m.start_at
  limit least(coalesce(p_limit, 50), 100);
$$;
revoke execute on function open_matches(sport, player_level, timestamptz, timestamptz, text, text, int) from public, anon;
grant execute on function open_matches(sport, player_level, timestamptz, timestamptz, text, text, int) to authenticated;
