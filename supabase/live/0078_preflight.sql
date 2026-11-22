-- 0078 (M7 hide demo clubs) — PREFLIGHT. READ ONLY: one SELECT, changes nothing.
-- Run immediately before 0078 (staging first; live only after its own approval); 0077 must already be applied.
-- Every part-1 row must be ok = true, or 0078 is not applied. Part 2 is information for the switch decision
-- (counts only, no personal data).
with checks(part, item, ok, detail) as (
  select 1, 'none of 0078''s helper functions exists yet', not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname in ('demo_clubs_hidden','club_visible_to_me','club_has_my_history','club_readable_by_me')), ''
  union all select 1, 'clubs policies are the 0077 set (admin write FOR ALL, read)', (select string_agg(policyname || ':' || cmd, ',' order by policyname) from pg_policies where tablename = 'clubs') = 'clubs: admin write:ALL,clubs: read:SELECT', coalesce((select string_agg(policyname || ':' || cmd, ',' order by policyname) from pg_policies where tablename = 'clubs'), 'none')
  union all select 1, 'the switch is not set yet', not exists (select 1 from app_settings where key = 'hide_demo_clubs'), ''
  union all select 1, 'assert_valid_court_slot: the version 0078 replaces', (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = '842d14da33899a48cb53eb356bdf671c' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'assert_valid_court_slot'), coalesce((select string_agg(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g')), ',') from pg_proc where pronamespace = 'public'::regnamespace and proname = 'assert_valid_court_slot'), 'missing')
  union all select 1, 'club_day_slots: the version 0078 replaces', (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = '35ff8264c576bb8bcfb2ced788f2882e' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'club_day_slots'), coalesce((select string_agg(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g')), ',') from pg_proc where pronamespace = 'public'::regnamespace and proname = 'club_day_slots'), 'missing')
  union all select 1, 'club_discovery: the version 0078 replaces', (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = 'aba9a60d5ec08f3a4915bdae0013add9' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'club_discovery'), coalesce((select string_agg(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g')), ',') from pg_proc where pronamespace = 'public'::regnamespace and proname = 'club_discovery'), 'missing')
  union all select 1, 'coaches_directory: the version 0078 replaces', (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = '66c5da8e2a1c3f7e19f76fc8561ac9d7' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'coaches_directory'), coalesce((select string_agg(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g')), ',') from pg_proc where pronamespace = 'public'::regnamespace and proname = 'coaches_directory'), 'missing')
  union all select 1, 'open_matches: the version 0078 replaces', (select count(*) = 1 and max(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g'))) = '22e8b948d653fbd83f73ad1e5e0d29e9' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'open_matches'), coalesce((select string_agg(md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g')), ',') from pg_proc where pronamespace = 'public'::regnamespace and proname = 'open_matches'), 'missing')
  union all select 2, 'demo clubs (is_demo = true)', true, (select count(*)::text from clubs where is_demo)
  union all select 2, 'non-demo active clubs (stay public)', true, (select count(*)::text from clubs where active and not is_demo)
  union all select 2, 'upcoming confirmed or pending player bookings at demo clubs (not staff, not walk-in)', true,
    (select count(*)::text from bookings b join clubs c on c.id = b.club_id where c.is_demo and b.player_id is not null
       and b.status in ('confirmed','pending') and b.start_at > now()
       and not exists (select 1 from club_staff s where s.club_id = b.club_id and s.profile_id = b.player_id))
  union all select 2, 'open upcoming games at demo clubs', true,
    (select count(*)::text from matches m join clubs c on c.id = m.club_id where c.is_demo and m.status = 'open' and m.start_at > now())
)
select part, item, ok, detail from checks order by part, item;
