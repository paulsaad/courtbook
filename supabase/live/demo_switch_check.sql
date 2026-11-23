-- Demo-club switch (hide_demo_clubs) — READ ONLY: one SELECT, changes nothing. Valid in any state from 0078 on
-- (it pins no function versions, so 0084 replacing the slot check does not affect it). Demo clubs are counted only when
-- published: an unpublished club is hidden whatever the switch (0085). Run after turning the switch
-- on or off. Every row must be ok = true. Run in the SQL editor or by the staging workflow (no signed-in user, so the
-- "signed-out visitor" rows show what anon sees).
with checks(item, ok, detail) as (
  select 'switch: hide_demo_clubs is ' || case when demo_clubs_hidden() then 'ON' else 'off' end, true, coalesce((select value from app_settings where key = 'hide_demo_clubs'), 'not set')
  union all select 'signed-out visitor: published demo clubs readable match the switch (0 when ON, all when off)',
    (select count(*) from clubs where is_demo and active and club_readable_by_me(id, is_demo)) = case when demo_clubs_hidden() then 0 else (select count(*) from clubs where is_demo and active) end,
    (select count(*) from clubs where is_demo and active and club_readable_by_me(id, is_demo))::text || ' of ' || (select count(*) from clubs where is_demo and active)::text
  union all select 'signed-out visitor: every published non-demo club stays readable', (select count(*) from clubs where active and not is_demo and not club_readable_by_me(id, is_demo)) = 0, ''
  union all select 'signed-out visitor: discovery shows demo clubs only when off',
    not demo_clubs_hidden() or not exists (select 1 from club_discovery() d join clubs c on c.slug = d.slug where c.is_demo), ''
  union all select 'signed-out visitor: courts of published demo clubs readable match the switch',
    (select count(*) from courts k join clubs c on c.id = k.club_id where c.is_demo and c.active and club_id_readable_by_me(k.club_id)) = case when demo_clubs_hidden() then 0 else (select count(*) from courts k join clubs c on c.id = k.club_id where c.is_demo and c.active) end,
    (select count(*) from courts k join clubs c on c.id = k.club_id where c.is_demo and c.active and club_id_readable_by_me(k.club_id))::text
  -- 0085: an unpublished club (demo or not) is never readable by visitors, whatever the switch. Before 0085 this row is
  -- information only (unpublished clubs were readable then).
  union all select 'signed-out visitor: unpublished demo clubs and their courts are never readable (0085; switch either way)',
    not exists (select 1 from pg_proc where proname = 'club_visible_to_me' and pronamespace = 'public'::regnamespace and prosrc like '%0085%')
    or ((select count(*) from clubs where is_demo and not active and club_readable_by_me(id, is_demo))
        + (select count(*) from courts k join clubs c on c.id = k.club_id where c.is_demo and not c.active and club_id_readable_by_me(k.club_id))) = 0,
    case when exists (select 1 from pg_proc where proname = 'club_visible_to_me' and pronamespace = 'public'::regnamespace and prosrc like '%0085%')
         then (select count(*) from clubs where is_demo and not active)::text || ' unpublished demo club(s); readable: '
              || (select count(*) from clubs where is_demo and not active and club_readable_by_me(id, is_demo))::text
         else 'before 0085: not applicable' end
  union all select 'the read rules on clubs and courts are exactly the hiding checks (the only select rules there)',
    (select string_agg(polrelid::regclass || ':' || pg_get_expr(polqual, polrelid), ' ; ' order by polrelid::regclass::text)
       from pg_policy where polrelid in ('clubs'::regclass, 'courts'::regclass) and polcmd in ('r', '*'))
    = 'clubs:club_readable_by_me(id, is_demo) ; courts:club_id_readable_by_me(club_id)'
    and (select bool_and(relrowsecurity) from pg_class where oid in ('clubs'::regclass, 'courts'::regclass)),
    (select string_agg(polrelid::regclass || ':' || polname, ', ') from pg_policy where polrelid in ('clubs'::regclass, 'courts'::regclass) and polcmd in ('r', '*'))
  union all select 'the age switch is untouched by this action (require_age_confirmation not on)', coalesce((select value from app_settings where key = 'require_age_confirmation'), 'false') <> 'true', ''
)
select item, ok, detail from checks order by ok, item;
