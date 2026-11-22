-- 0078 — Hide demo clubs from public discovery (master launch checklist M7).
--
-- A demo club (clubs.is_demo, 0063) is fictional and offers simulated payment (0070 allows it only there). Real
-- players must not find or book it once CourtBook is public, but staff of that club and admins keep full access so
-- it stays usable for testing and store review.
--
-- Switch: app_settings 'hide_demo_clubs' = 'true'. Absent or anything else = shown (staging and every test suite keep
-- today's behaviour). The live rollout inserts 'true' as its own approved step, with a read-only check after.
--
-- When hidden, for anyone who is not staff of that club or an admin:
--   - clubs rows are not readable (RLS) -> club pages, booking sheet, app club screen answer "not found";
--   - club_day_slots, club_discovery, open_matches and coaches_directory leave the club out;
--   - booking at it is refused as club_not_found (shared slot check used by hold_slot, book_at_desk, staff_book,
--     moves and the bookings trigger). Calls without a signed-in user (server jobs) are not affected.
-- Also: the admin write policy is split by command (same rights; see below).
-- Not changed: bookings already made, payments, staff and admin pages, detail functions reached by id, courts and
-- media read policies (no club name or listing), every booking-safety rule.

create or replace function demo_clubs_hidden() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select value from app_settings where key = 'hide_demo_clubs'), 'false') = 'true';
$$;

create or replace function club_visible_to_me(p_club uuid, p_is_demo boolean) returns boolean
language sql stable security definer set search_path = public as $$
  select not coalesce(p_is_demo, false)
      or not demo_clubs_hidden()
      or (auth.uid() is not null and (is_staff_of(p_club) or is_admin()));
$$;

revoke all on function demo_clubs_hidden() from public, anon, authenticated;
revoke all on function club_visible_to_me(uuid, boolean) from public, anon, authenticated;
-- only the security-definer helper below needs the switch; not exposed to anon or signed-in users
grant execute on function demo_clubs_hidden() to service_role;
-- called inside security-definer functions; signed-in users keep execute for invoker-context callers (triggers)
grant execute on function club_visible_to_me(uuid, boolean) to authenticated, service_role;

-- The admin policy was FOR ALL, so it also took part in every SELECT; while the read policy was `true` the planner
-- folded the check away. With a real read condition, a signed-out read would evaluate is_admin() (not executable by
-- anon). Same admin rights, split by command so it no longer applies to reads (admins read through the read policy).
drop policy if exists "clubs: admin write" on clubs;
drop policy if exists "clubs: admin insert" on clubs;
drop policy if exists "clubs: admin update" on clubs;
drop policy if exists "clubs: admin delete" on clubs;
create policy "clubs: admin insert" on clubs for insert with check (is_admin());
create policy "clubs: admin update" on clubs for update using (is_admin()) with check (is_admin());
create policy "clubs: admin delete" on clubs for delete using (is_admin());

drop policy if exists "clubs: read" on clubs;
-- A signed-in user with their own history at a hidden club (a booking, a game, a coach link) can still read
-- its row, so existing booking, payment and game screens keep showing the club name instead of failing.
-- Discovery, the board, day slots, the coach directory and new bookings stay strict (club_visible_to_me only).
create or replace function club_has_my_history(p_club uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
       exists (select 1 from bookings b where b.club_id = p_club and b.player_id = auth.uid())
    or exists (select 1 from matches m where m.club_id = p_club and m.organizer_id = auth.uid())
    or exists (select 1 from matches m join match_players mp on mp.match_id = m.id
               where m.club_id = p_club and mp.profile_id = auth.uid())
    or exists (select 1 from coach_clubs cc join coaches co on co.id = cc.coach_id
               where cc.club_id = p_club and co.profile_id = auth.uid()));
$$;
revoke all on function club_has_my_history(uuid) from public, anon, authenticated;
grant execute on function club_has_my_history(uuid) to service_role;
-- the clubs read policy: one boolean-only function, so anon needs execute on nothing else
create or replace function club_readable_by_me(p_club uuid, p_is_demo boolean) returns boolean
language sql stable security definer set search_path = public as $$
  select club_visible_to_me(p_club, p_is_demo) or club_has_my_history(p_club);
$$;
revoke all on function club_readable_by_me(uuid, boolean) from public, anon, authenticated;
grant execute on function club_readable_by_me(uuid, boolean) to anon, authenticated, service_role;
create policy "clubs: read" on clubs for select using (club_readable_by_me(id, is_demo));

CREATE OR REPLACE FUNCTION public.club_day_slots(p_date date, p_sport sport DEFAULT NULL::sport, p_governorate text DEFAULT NULL::text, p_district text DEFAULT NULL::text, p_query text DEFAULT NULL::text)
 RETURNS TABLE(club_id uuid, club_name text, slug text, town text, district text, price_from numeric, sports sport[], slot_minutes integer, min_minutes integer, max_minutes integer, service_fee_usd numeric, hold_minutes integer, cancel_cutoff_hours integer, timezone text, court_id uuid, court_name text, court_sport sport, start_at timestamp with time zone, free_minutes integer, is_demo boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    where cl.active and club_visible_to_me(cl.id, cl.is_demo)
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
end $function$;

CREATE OR REPLACE FUNCTION public.club_discovery(p_sport sport DEFAULT NULL::sport, p_governorate text DEFAULT NULL::text, p_district text DEFAULT NULL::text, p_query text DEFAULT NULL::text)
 RETURNS TABLE(club_id uuid, name text, slug text, town text, district text, governorate text, district_code text, governorate_code text, sports sport[], price_from numeric, next_free_at timestamp with time zone, next_free_court text, next_free_court_id uuid, cover_url text, location_url text, open_time time without time zone, close_time time without time zone, is_demo boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with q as (select nullif(trim(p_query), '') as text)
  select c.id, c.name, c.slug, t.name_en, d.name_en, g.name_en, d.code, g.code,
         club_sports(c.id),
         (select min(pr.price_usd) from price_rules pr
           where pr.club_id = c.id
             and (pr.court_id is null or exists (select 1 from courts k where k.id = pr.court_id and k.active and (p_sport is null or k.sport = p_sport)))),
         nf.start_at, nf.court_name, nf.court_id, c.cover_url, c.location_url, c.open_time, c.close_time, c.is_demo
  from clubs c
  left join towns t on t.id = c.town_id
  left join districts d on d.code = t.district_code
  left join governorates g on g.code = d.governorate_code
  left join lateral next_free_slot(c.id, p_sport) nf on true
  cross join q
  where c.active and club_visible_to_me(c.id, c.is_demo)
    and (p_sport is null or exists (select 1 from courts k where k.club_id = c.id and k.active and k.sport = p_sport))
    and (p_governorate is null or g.code = p_governorate)
    and (p_district is null or d.code = p_district)
    and (q.text is null or c.name ilike '%' || q.text || '%' or t.name_en ilike '%' || q.text || '%' or t.name_ar like '%' || q.text || '%')
  order by (nf.start_at is null), g.sort_order nulls last, d.sort_order nulls last, c.name
  limit 100;
$function$;

CREATE OR REPLACE FUNCTION public.open_matches(p_sport sport DEFAULT NULL::sport, p_fit text DEFAULT NULL::text, p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_governorate text DEFAULT NULL::text, p_district text DEFAULT NULL::text, p_limit integer DEFAULT 50)
 RETURNS TABLE(match_id uuid, club_id uuid, club_name text, club_slug text, town text, sport sport, start_at timestamp with time zone, end_at timestamp with time zone, level_min integer, level_max integer, level_legacy boolean, my_level integer, players_needed integer, joined integer, note text, organizer_name text, join_mode text, i_joined boolean, booking_id uuid, court_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select m.id, m.club_id, c.name, c.slug, t.name_en, m.sport, m.start_at, m.end_at,
         (match_level_bounds(m))[1], (match_level_bounds(m))[2], m.level_min is null and m.level is not null,
         pl.level,
         m.players_needed,
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
  left join player_levels pl on pl.profile_id = auth.uid() and pl.sport = m.sport
  where auth.uid() is not null and m.status = 'open' and m.organizer_id <> auth.uid()
    and club_visible_to_me(c.id, c.is_demo)
    and not players_blocked(auth.uid(), m.organizer_id)
    and m.start_at > coalesce(p_from, now()) and m.start_at < coalesce(p_to, now() + interval '14 days')
    and (p_sport is null or m.sport = p_sport)
    and (p_fit is distinct from 'mine' or pl.level is null or match_level_bounds(m) is null
         or (pl.level between (match_level_bounds(m))[1] and (match_level_bounds(m))[2]))
    and (p_governorate is null or d.governorate_code = p_governorate)
    and (p_district is null or d.code = p_district)
  order by m.start_at
  limit least(coalesce(p_limit, 50), 100);
$function$;

CREATE OR REPLACE FUNCTION public.coaches_directory(p_governorate text DEFAULT NULL::text, p_district text DEFAULT NULL::text)
 RETURNS TABLE(coach_id uuid, name text, sports sport[], levels player_level[], price_usd numeric, whatsapp text, club_id uuid, club_name text, club_slug text, town text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select c.id, p.name, c.sports, c.levels, c.price_usd, c.whatsapp, cl.id, cl.name, cl.slug, tw.name_en
  from coaches c
  join profiles p on p.id = c.profile_id
  join coach_clubs cc on cc.coach_id = c.id and cc.status = 'approved'
  join clubs cl on cl.id = cc.club_id and cl.active and club_visible_to_me(cl.id, cl.is_demo)
  left join towns tw on tw.id = cl.town_id
  left join districts d on d.code = tw.district_code
  where auth.uid() is not null and c.active
    and (p_governorate is null or d.governorate_code = p_governorate)
    and (p_district is null or d.code = p_district)
  order by p.name, cl.name;
$function$;

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
  if start_min < (extract(epoch from c.open_time) / 60)::int
     or end_min > (extract(epoch from c.close_time) / 60)::int then
    raise exception 'outside_opening_hours';
  end if;
  if (start_min - (extract(epoch from c.open_time) / 60)::int) % c.slot_minutes <> 0 then
    raise exception 'not_on_grid';
  end if;
end $function$;
