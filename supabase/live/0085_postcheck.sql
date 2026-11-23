-- 0085 (unpublished clubs unreadable) — POSTCHECK. READ ONLY: one SELECT, changes nothing. Every row must be ok = true.
-- "Signed out" rows ask the same functions the read rules use, as a visitor (no signed-in user).
with checks(item, ok, detail) as (
  select 'club_visible_to_me is the 0085 version',
    (select md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g')) from pg_proc where proname = 'club_visible_to_me' and pronamespace = 'public'::regnamespace) = 'e19b2e3ef666e34e4b1240f591b90d63',
    coalesce((select md5(regexp_replace(prosrc, '[ \t\r]+(\n|$)', '\1', 'g')) from pg_proc where proname = 'club_visible_to_me' and pronamespace = 'public'::regnamespace), 'missing')
  union all select 'occupancy leaves out clubs the reader cannot see (bookings and blocks), keeps the reader''s own bookings',
    pg_get_viewdef('occupancy'::regclass) like '%club_id_visible_to_me(bookings.club_id)%'
    and pg_get_viewdef('occupancy'::regclass) like '%club_id_visible_to_me(blocks.club_id)%'
    and pg_get_viewdef('occupancy'::regclass) like '%bookings.player_id = auth.uid()) OR club_id_visible_to_me%', ''
  union all select 'occupancy: signed-in only, as before', has_table_privilege('authenticated', 'occupancy', 'select') and not has_table_privilege('anon', 'occupancy', 'select'), ''
  union all select 'helpers keep their privileges (club_visible_to_me not callable by visitors; the read-rule helper is)',
    not has_function_privilege('anon', 'club_visible_to_me(uuid,boolean)', 'execute') and has_function_privilege('anon', 'club_readable_by_me(uuid,boolean)', 'execute'), ''
  union all select 'signed out: no unpublished club is readable',
    not exists (select 1 from clubs where not active and club_readable_by_me(id, is_demo)),
    (select count(*) from clubs where not active and club_readable_by_me(id, is_demo))::text
  union all select 'signed out: every published non-demo club stays readable',
    not exists (select 1 from clubs where active and not is_demo and not club_readable_by_me(id, is_demo)), ''
  union all select 'signed out: demo clubs readable while the demo switch is off (as before)',
    not exists (select 1 from clubs where active and is_demo and not club_readable_by_me(id, is_demo)), ''
  union all select 'neither switch is on', not exists (select 1 from app_settings where key in ('hide_demo_clubs', 'require_age_confirmation') and value = 'true'), ''
)
select item, ok, detail from checks order by ok, item;
