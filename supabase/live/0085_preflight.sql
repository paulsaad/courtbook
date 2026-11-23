-- 0085 (unpublished clubs unreadable) — PREFLIGHT. READ ONLY: one SELECT, changes nothing.
-- Run immediately before applying 0085. Every part-1 row must be ok = true, or nothing is applied.
-- Part 2 is information (counts only, no names).
with checks(part, item, ok, detail) as (
  select 1, 'launch-1 (0078–0084) is applied: club_visible_to_me is the launch-1 version',
    (select md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g')) from pg_proc where proname = 'club_visible_to_me' and pronamespace = 'public'::regnamespace) = 'e73692ed82cd41ecb32b1fe795d441cc',
    coalesce((select md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g')) from pg_proc where proname = 'club_visible_to_me' and pronamespace = 'public'::regnamespace), 'missing')
  union all select 1, 'occupancy is the version before 0085 (no visibility filter yet)',
    pg_get_viewdef('occupancy'::regclass) not like '%club_id_visible_to_me%', ''
  union all select 1, 'public_occupancy lists published clubs only (unchanged by 0085)',
    pg_get_viewdef('public_occupancy'::regclass) like '%c.active%', ''
  union all select 1, 'neither switch is on', not exists (select 1 from app_settings where key in ('hide_demo_clubs', 'require_age_confirmation') and value = 'true'), ''
  union all select 2, 'clubs: published / unpublished / demo', true,
    (select count(*) filter (where active) || ' / ' || count(*) filter (where not active) || ' / ' || count(*) filter (where is_demo) from clubs)
  union all select 2, 'bookings and games at unpublished clubs (players keep reading those clubs)', true,
    (select count(*) from bookings b join clubs c on c.id = b.club_id where not c.active)::text || ' / '
    || (select count(*) from matches m join clubs c on c.id = m.club_id where not c.active)::text
)
select part, item, ok, detail from checks order by part, ok, item;
