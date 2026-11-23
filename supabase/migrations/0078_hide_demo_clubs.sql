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

-- ============ every other path (review hardening, 23 Nov) ============
-- The checks above cover the clubs row and the four discovery functions. These cover what remained: the second game
-- board (match_board, used by the club Games page and the apps), game detail, open games read straight from the table,
-- courts / prices / photos read straight from their tables, the next-free-slot and price functions, club sports, the
-- coach pages, and posting or joining a game at a hidden club. History holders keep what they need (their own games,
-- their booking's court name); nothing new can be started at a hidden club.
create or replace function club_id_visible_to_me(p_club uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select club_visible_to_me(c.id, c.is_demo) from clubs c where c.id = p_club), true);
$$;
create or replace function club_id_readable_by_me(p_club uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select club_readable_by_me(c.id, c.is_demo) from clubs c where c.id = p_club), true);
$$;
revoke all on function club_id_visible_to_me(uuid) from public, anon, authenticated;
revoke all on function club_id_readable_by_me(uuid) from public, anon, authenticated;
-- used by read policies below, evaluated as the caller: boolean only
grant execute on function club_id_visible_to_me(uuid) to anon, authenticated, service_role;
grant execute on function club_id_readable_by_me(uuid) to anon, authenticated, service_role;

-- open games straight from the table: only at clubs the caller may see (members, organiser, staff, admin unchanged)
drop policy if exists "matches: read" on matches;
create policy "matches: read" on matches for select using (
  (status = 'open' and club_id_visible_to_me(club_id)) or organizer_id = auth.uid() or is_in_match(id) or is_staff_of(club_id) or is_admin());

-- courts, prices, photos: readable where the club row is (so a booking's court name still shows for its owner).
-- The staff FOR ALL policies are split by command, as for clubs: a FOR ALL policy also joins every SELECT, and
-- is_staff_of is not executable by anon.
drop policy if exists "courts: read" on courts;
create policy "courts: read" on courts for select using (club_id_readable_by_me(club_id));
drop policy if exists "price_rules: read" on price_rules;
create policy "price_rules: read" on price_rules for select using (club_id_readable_by_me(club_id));
drop policy if exists "club_media: read" on club_media;
create policy "club_media: read" on club_media for select using (club_id_readable_by_me(club_id));
drop policy if exists "courts: staff write" on courts;
drop policy if exists "courts: staff insert" on courts; drop policy if exists "courts: staff update" on courts; drop policy if exists "courts: staff delete" on courts;
create policy "courts: staff insert" on courts for insert with check (is_staff_of(club_id));
create policy "courts: staff update" on courts for update using (is_staff_of(club_id)) with check (is_staff_of(club_id));
create policy "courts: staff delete" on courts for delete using (is_staff_of(club_id));
drop policy if exists "price_rules: staff write" on price_rules;
drop policy if exists "price_rules: staff insert" on price_rules; drop policy if exists "price_rules: staff update" on price_rules; drop policy if exists "price_rules: staff delete" on price_rules;
create policy "price_rules: staff insert" on price_rules for insert with check (is_staff_of(club_id));
create policy "price_rules: staff update" on price_rules for update using (is_staff_of(club_id)) with check (is_staff_of(club_id));
create policy "price_rules: staff delete" on price_rules for delete using (is_staff_of(club_id));

-- functions: the exact current bodies with one visibility line each (generated from pg_get_functiondef)
CREATE OR REPLACE FUNCTION public.match_board(p_club uuid, p_days integer)
 RETURNS TABLE(match_id uuid, club_id uuid, club_name text, club_slug text, sport sport, start_at timestamp with time zone, end_at timestamp with time zone, level_min integer, level_max integer, level_legacy boolean, my_level integer, players_needed integer, joined integer, pending integer, status match_status, closed_reason text, note text, join_mode text, organizer_id uuid, organizer_name text, my_status text, i_organize boolean, booking_id uuid, court_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select m.id, m.club_id, c.name, c.slug, m.sport, m.start_at, m.end_at,
         (match_level_bounds(m))[1], (match_level_bounds(m))[2], m.level_min is null and m.level is not null,
         (select pl.level from player_levels pl where pl.profile_id = auth.uid() and pl.sport = m.sport),
         m.players_needed,
         (select count(*) from match_players mp where mp.match_id = m.id and mp.status = 'accepted')::int,
         (select count(*) from match_players mp where mp.match_id = m.id and mp.status = 'pending')::int,
         m.status, m.closed_reason, m.note, m.join_mode, m.organizer_id, o.name,
         (select mp.status from match_players mp where mp.match_id = m.id and mp.profile_id = auth.uid()),
         m.organizer_id = auth.uid(),
         m.booking_id, k.name
  from matches m
  left join clubs c on c.id = m.club_id
  left join profiles o on o.id = m.organizer_id
  left join bookings b on b.id = m.booking_id
  left join courts k on k.id = b.court_id
  where auth.uid() is not null
    and (p_club is null or m.club_id = p_club)
    and m.start_at > now() and m.start_at < now() + make_interval(days => coalesce(p_days, 14))
    and ((m.status = 'open' and not players_blocked(auth.uid(), m.organizer_id) and club_visible_to_me(m.club_id, c.is_demo))
         or m.organizer_id = auth.uid()
         or exists (select 1 from match_players mp where mp.match_id = m.id and mp.profile_id = auth.uid()
                      and mp.status in ('accepted', 'pending')))
  order by m.start_at;
$function$;

CREATE OR REPLACE FUNCTION public.match_detail(p_match uuid)
 RETURNS TABLE(match_id uuid, club_id uuid, club_name text, club_slug text, club_timezone text, town text, sport sport, start_at timestamp with time zone, end_at timestamp with time zone, level_min integer, level_max integer, level_legacy boolean, my_level integer, players_needed integer, joined integer, pending integer, status match_status, closed_reason text, court_lost boolean, note text, join_mode text, organizer_id uuid, organizer_name text, my_status text, i_organize boolean, has_court boolean, booking_id uuid, court_name text, started boolean, finished boolean, hidden boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select m.id, m.club_id, c.name, c.slug, c.timezone, t.name_en,
         m.sport, m.start_at, m.end_at,
         (match_level_bounds(m))[1], (match_level_bounds(m))[2], m.level_min is null and m.level is not null,
         (select pl.level from player_levels pl where pl.profile_id = auth.uid() and pl.sport = m.sport),
         m.players_needed,
         (select count(*) from match_players x where x.match_id = m.id and x.status = 'accepted')::int,
         -- request count only for the organiser
         case when m.organizer_id = auth.uid() then
           (select count(*) from match_players x where x.match_id = m.id and x.status = 'pending')::int end,
         m.status, m.closed_reason, m.court_lost_at is not null,
         m.note,                      -- organiser's public description: already on the board (open_matches)
         m.join_mode,
         -- identifiers only for insiders (organiser, accepted players, club staff, admin); others get
         -- null. Discovery needs neither (field review, docs/m3/02-safety-review.md S6).
         case when insider then m.organizer_id end,
         o.name,
         me.status, m.organizer_id = auth.uid(),
         m.booking_id is not null,
         case when insider then m.booking_id end,
         k.name,
         m.start_at <= now(),
         coalesce(m.end_at, m.start_at + interval '3 hours') <= now(),   -- same rule as hide_match
         exists (select 1 from match_hidden h where h.match_id = m.id and h.profile_id = auth.uid())
  from matches m
  left join clubs c on c.id = m.club_id
  left join towns t on t.id = c.town_id
  left join profiles o on o.id = m.organizer_id
  left join bookings b on b.id = m.booking_id
  left join courts k on k.id = b.court_id
  left join match_players me on me.match_id = m.id and me.profile_id = auth.uid()
  cross join lateral (select (m.organizer_id = auth.uid() or me.status = 'accepted'
                              or is_staff_of(m.club_id) or is_admin()) as insider) i
  where m.id = p_match
    and auth.uid() is not null
    and (
         m.organizer_id = auth.uid()                                   -- organiser: always
      or me.status in ('accepted', 'pending')                          -- member or requester: always
      or (m.status = 'open' and m.start_at > now() and club_visible_to_me(m.club_id, c.is_demo))  -- anyone signed in (incl. declined,
                                                                       --   removed, left): only while joinable
      or is_staff_of(m.club_id)                                        -- club staff (web staff pages)
      or is_admin()
    );
$function$;

CREATE OR REPLACE FUNCTION public.next_free_slot(p_club uuid, p_sport sport DEFAULT NULL::sport)
 RETURNS TABLE(start_at timestamp with time zone, court_id uuid, court_name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  c clubs%rowtype; l_now timestamp; day0 timestamp; open_min int; close_min int; m int; t timestamptz; t_end timestamptz; r record;
begin
  select * into c from clubs where id = p_club and active;
  if not found then return; end if;
  if not club_visible_to_me(c.id, c.is_demo) then return; end if;   -- 0078
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
end $function$;

CREATE OR REPLACE FUNCTION public.quote_price(p_court uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  c clubs%rowtype;
  v_court courts%rowtype;
  t timestamptz := p_start;
  total numeric := 0;
  step_price numeric;
  l_time time;
  l_dow int;   -- 0 = Monday
begin
  if p_start is null or p_end is null or not isfinite(p_start) or not isfinite(p_end) then raise exception 'bad_range'; end if;
  if p_end <= p_start then raise exception 'bad_range'; end if;
  select * into v_court from courts where id = p_court and active;
  if not found then raise exception 'court_not_found'; end if;
  select * into c from clubs where id = v_court.club_id and active;
  if not found then raise exception 'club_not_found'; end if;
  if not club_visible_to_me(c.id, c.is_demo) then raise exception 'club_not_found'; end if;   -- 0078
  if p_end - p_start > make_interval(mins => c.max_booking_minutes) then raise exception 'too_long'; end if;
  while t < p_end loop
    l_time := (t at time zone c.timezone)::time;
    l_dow  := extract(isodow from (t at time zone c.timezone))::int - 1;
    select pr.price_usd into step_price
    from price_rules pr
    where pr.club_id = c.id
      and (pr.court_id = p_court or pr.court_id is null)
      and (pr.weekday_mask & (1 << l_dow)) <> 0
      and pr.start_time <= l_time and l_time < pr.end_time
    order by pr.court_id nulls last           -- court-specific rule wins
    limit 1;
    if step_price is null then raise exception 'no_price_rule'; end if;
    total := total + step_price * c.slot_minutes / 60.0;
    t := t + make_interval(mins => c.slot_minutes);
  end loop;
  return round(total, 2);
end $function$;

CREATE OR REPLACE FUNCTION public.club_sports(p_club uuid)
 RETURNS sport[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(array_agg(distinct c.sport order by c.sport), '{}') from courts c where c.club_id = p_club and c.active and club_id_visible_to_me(p_club);
$function$;

CREATE OR REPLACE FUNCTION public.coaches_at_club(p_club uuid)
 RETURNS TABLE(coach_id uuid, name text, sports sport[], levels player_level[], price_usd numeric, bio text, whatsapp text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select c.id, p.name, c.sports, c.levels, c.price_usd, c.bio, c.whatsapp
  from coaches c
  join coach_clubs cc on cc.coach_id = c.id and cc.club_id = p_club and cc.status = 'approved'
  join profiles p on p.id = c.profile_id
  where c.active and auth.uid() is not null and club_id_visible_to_me(p_club)
  order by p.name;
$function$;

CREATE OR REPLACE FUNCTION public.coach_card(p_coach uuid)
 RETURNS TABLE(coach_id uuid, name text, sports sport[], levels player_level[], price_usd numeric, bio text, whatsapp text, clubs jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select c.id, p.name, c.sports, c.levels, c.price_usd, c.bio, c.whatsapp,
         coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'name', k.name, 'slug', k.slug, 'timezone', k.timezone) order by k.name)
                   from coach_clubs cc join clubs k on k.id = cc.club_id where cc.coach_id = c.id and cc.status = 'approved'
                     and club_visible_to_me(k.id, k.is_demo)), '[]'::jsonb)
  from coaches c join profiles p on p.id = c.profile_id
  where c.id = p_coach and auth.uid() is not null
    and (c.active and exists (select 1 from coach_clubs cc join clubs k on k.id = cc.club_id where cc.coach_id = c.id and cc.status = 'approved'
                                and club_visible_to_me(k.id, k.is_demo))
         or c.profile_id = auth.uid() or is_admin());
$function$;

CREATE OR REPLACE FUNCTION public.post_match(p_club uuid, p_sport sport, p_start timestamp with time zone, p_end timestamp with time zone, p_level_min integer, p_level_max integer, p_players_needed integer, p_note text, p_booking uuid, p_join_mode text DEFAULT 'open'::text, p_token uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid := gen_random_uuid();
  b bookings%rowtype;
  v_court_sport sport;
  v_existing uuid;
  v_constraint text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  perform assert_active();             -- M3-S: a suspended account makes no game changes
  -- a repeat of a post that already succeeded: the same game, nothing new (checked before any rule,
  -- so a retry is not refused by a limit the first call itself reached)
  if p_token is not null then
    select id into v_existing from matches where organizer_id = auth.uid() and client_token = p_token;
    if v_existing is not null then return v_existing; end if;
  end if;
  if p_booking is not null then
    select * into b from bookings where id = p_booking and player_id = auth.uid() for update;
    if not found or b.status <> 'confirmed' then raise exception 'booking_not_found'; end if;
    select sport into v_court_sport from courts where id = b.court_id;
    if v_court_sport is not null and v_court_sport <> p_sport then raise exception 'sport_mismatch'; end if;
    if exists (select 1 from matches where booking_id = p_booking and status <> 'cancelled') then raise exception 'booking_already_posted'; end if;
    p_club := b.club_id; p_start := b.start_at; p_end := b.end_at;
  else
    if p_club is null then raise exception 'club_required'; end if;
    if p_start is not null and p_start >= now() + interval '60 days' then raise exception 'too_far_ahead'; end if;
  end if;
  if not club_id_visible_to_me(p_club) then raise exception 'club_not_found'; end if;   -- 0078: no new game at a hidden club
  if p_start is null or p_start <= now() then raise exception 'slot_in_past'; end if;
  if p_end is not null and p_end <= p_start then raise exception 'bad_range'; end if;
  if p_players_needed is null or p_players_needed < 1 or p_players_needed > 30 then raise exception 'bad_players_needed'; end if;
  if p_join_mode not in ('open', 'approval') then raise exception 'bad_join_mode'; end if;
  if length(coalesce(p_note, '')) > 300 then raise exception 'note_too_long'; end if;
  if (p_level_min is null) <> (p_level_max is null) or (p_level_min is not null and (p_level_min < 1 or p_level_max > 10 or p_level_min > p_level_max)) then raise exception 'bad_level_range'; end if;
  -- S12: live games = not cancelled and not started; one count at a time per organiser, so two
  -- simultaneous posts cannot both see 9 (and two retries with one key wait for each other here)
  perform pg_advisory_xact_lock(hashtextextended('courtbook:post_match:' || auth.uid()::text, 0));
  if p_token is not null then
    select id into v_existing from matches where organizer_id = auth.uid() and client_token = p_token;
    if v_existing is not null then return v_existing; end if;
  end if;
  if (select count(*) from matches where organizer_id = auth.uid() and status <> 'cancelled' and start_at > now()) >= 10 then
    raise exception 'too_many_games';
  end if;
  insert into matches (id, club_id, sport, organizer_id, start_at, end_at, level_min, level_max, players_needed, note, booking_id, join_mode, client_token)
  values (v_id, p_club, p_sport, auth.uid(), p_start, p_end, p_level_min, p_level_max, p_players_needed, nullif(trim(p_note), ''), p_booking, p_join_mode, p_token);
  return v_id;
exception when unique_violation then
  get stacked diagnostics v_constraint = constraint_name;
  if v_constraint = 'matches_organizer_client_token' then
    select id into v_existing from matches where organizer_id = auth.uid() and client_token = p_token;
    if v_existing is not null then return v_existing; end if;
  end if;
  raise exception 'booking_already_posted';
end $function$;

CREATE OR REPLACE FUNCTION public.join_match(p_match uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare m matches%rowtype; n int; me text; cur text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  perform assert_active();             -- M3-S: a suspended account makes no game changes
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if not club_id_visible_to_me(m.club_id) then raise exception 'not_found'; end if;   -- 0078
  if m.status <> 'open' or m.start_at <= now() then raise exception 'match_closed'; end if;
  if m.organizer_id = auth.uid() then raise exception 'organizer_cannot_join'; end if;

  select status into cur from match_players where match_id = p_match and profile_id = auth.uid();
  if cur in ('accepted', 'pending') then return cur; end if;       -- idempotent
  if cur = 'declined' then raise exception 'join_declined'; end if; -- final (GR-5, GR-6)

  select count(*) into n from match_players where match_id = p_match and status = 'accepted';
  if n >= m.players_needed then raise exception 'match_full'; end if;
  select coalesce(name, 'A player') into me from profiles where id = auth.uid();

  if m.join_mode = 'approval' then
    -- one count at a time per player: two requests to two different games cannot both see 19 (S12)
    perform pg_advisory_xact_lock(hashtextextended('courtbook:requests:' || auth.uid()::text, 0));
    if (select count(*) from match_players mp join matches x on x.id = mp.match_id
        where mp.profile_id = auth.uid() and mp.status = 'pending'
          and x.status <> 'cancelled' and x.start_at > now()) >= 20 then
      raise exception 'too_many_requests';
    end if;
    insert into match_players (match_id, profile_id, status) values (p_match, auth.uid(), 'pending');
    perform notify(m.organizer_id, 'join_request', p_match, me || ' wants to join your match');
    return 'pending';
  end if;

  insert into match_players (match_id, profile_id, status) values (p_match, auth.uid(), 'accepted');
  perform notify(m.organizer_id, 'player_joined', p_match, me || ' joined your match');
  if n + 1 >= m.players_needed then
    update matches set status = 'closed', closed_at = now(), closed_reason = 'full' where id = p_match;
    perform notify_waiting(p_match);
  end if;
  return 'accepted';
end $function$;
