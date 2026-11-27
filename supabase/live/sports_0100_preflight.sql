-- 0100 (sports catalogue): READ-ONLY preflight, run before supabase/migrations/0100_sports_catalogue.sql.
-- Every line must end in OK. Any STOP: do not apply; report it. Changes nothing (selects only).
--   psql "$DB" -X -At -F'|' -f supabase/live/sports_0100_preflight.sql
-- Each STOP is a reason the migration would fail half-way (it runs in one transaction, so it would change nothing) or
-- would leave existing rows that the new rules refuse to save again.
select 'S1 sport is still the enum (0100 not applied yet)',
  coalesce((select t.typtype::text from pg_type t where t.typname = 'sport' and t.typnamespace = 'public'::regnamespace), 'missing'),
  case when (select t.typtype from pg_type t where t.typname = 'sport' and t.typnamespace = 'public'::regnamespace) = 'e' then 'OK' else 'STOP' end
union all
select 'S2 every sport code fits the new code format ^[a-z][a-z0-9_]{1,30}$',
  coalesce(string_agg(code::text, ','), 'all fit'), case when count(*) = 0 then 'OK' else 'STOP' end
  from sports where code::text !~ '^[a-z][a-z0-9_]{1,30}$'
union all
select 'S3 every sport used by a court, game or level is in the sports table (the new foreign keys)',
  count(*)::text, case when count(*) = 0 then 'OK' else 'STOP' end
  from (select sport::text from courts union all select sport::text from matches union all select sport::text from player_levels) u
  where not exists (select 1 from sports s where s.code::text = u.sport)
union all
select 'S4 no profile or coach lists an empty (NULL) sport (the new guard would refuse their next save)',
  ((select count(*) from profiles where array_position(sports, null) is not null) + (select count(*) from coaches where array_position(sports, null) is not null))::text,
  case when (select count(*) from profiles where array_position(sports, null) is not null) + (select count(*) from coaches where array_position(sports, null) is not null) = 0 then 'OK' else 'STOP' end
union all
select 'S5 every sport name is present and has no spaces at either end (new check constraints)',
  coalesce(string_agg(code::text, ','), 'none'), case when count(*) = 0 then 'OK' else 'STOP' end
  from sports where name_en is null or btrim(name_en) = '' or name_en <> btrim(name_en)
union all
select 'S6 no two sports share a name, ignoring case (new unique index)',
  coalesce(string_agg(lower(name_en), ','), 'none'), case when count(*) = 0 then 'OK' else 'STOP' end
  from (select lower(name_en) as name_en from sports group by lower(name_en) having count(*) > 1) d
union all
select 'S7 no other sport is already called "Table tennis" (the new row would clash)',
  coalesce(string_agg(code::text, ','), 'none'), case when count(*) = 0 then 'OK' else 'STOP' end
  from sports where lower(name_en) = 'table tennis' and code::text <> 'table_tennis'
union all
select 'S8 club_discovery and club_day_slots have the search text 0100 extends (0078''s)',
  (position('t.name_ar like ''%'' || q.text || ''%'')' in pg_get_functiondef(to_regprocedure('public.club_discovery(sport,text,text,text)'))) > 0)::text
    || '/' || (position('tw.name_ar like ''%'' || q || ''%'')' in pg_get_functiondef(to_regprocedure('public.club_day_slots(date,sport,text,text,text)'))) > 0)::text,
  case when position('t.name_ar like ''%'' || q.text || ''%'')' in pg_get_functiondef(to_regprocedure('public.club_discovery(sport,text,text,text)'))) > 0
        and position('tw.name_ar like ''%'' || q || ''%'')' in pg_get_functiondef(to_regprocedure('public.club_day_slots(date,sport,text,text,text)'))) > 0
       then 'OK' else 'STOP' end
union all
select 'S9 information: sports, active, in use by courts', (select count(*) from sports)::text || ' / ' || (select count(*) from sports where active)::text
  || ' / ' || (select count(distinct sport) from courts)::text, 'OK';
