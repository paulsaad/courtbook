-- 0100 (sports catalogue): READ-ONLY postcheck, run after supabase/migrations/0100_sports_catalogue.sql.
-- Every line must end in OK. Any STOP: report it (rollback: supabase/rollback/0100_down.sql, as one transaction).
--   psql "$DB" -X -At -F'|' -f supabase/live/sports_0100_postcheck.sql
select 'P1 sport is the domain over text; the old enum is gone',
  coalesce((select t.typtype::text from pg_type t where t.typname = 'sport' and t.typnamespace = 'public'::regnamespace), 'missing')
    || '/' || (to_regtype('public.sport_enum_retired') is null)::text,
  case when (select t.typtype from pg_type t where t.typname = 'sport' and t.typnamespace = 'public'::regnamespace) = 'd'
        and to_regtype('public.sport_enum_retired') is null then 'OK' else 'STOP' end
union all
select 'P2 table tennis is in the catalogue, inactive, with the "ping pong" alias',
  -- through to_jsonb and ::text, so that before 0100 (no aliases column, sport still the enum) this line says STOP
  coalesce((select s.active::text || ' ' || coalesce(to_jsonb(s) ->> 'aliases', 'no aliases') from sports s where s.code::text = 'table_tennis'), 'missing'),
  -- I-1: right after 0100 it must be INACTIVE. Run this postcheck right after 0100 only: after the separate, approved
  -- activation step this row says STOP by design.
  case when exists (select 1 from sports s where s.code::text = 'table_tennis' and not s.active and coalesce(to_jsonb(s) -> 'aliases', '[]'::jsonb) ? 'ping pong') then 'OK' else 'STOP' end
union all
select 'P3 courts, games and levels reference the catalogue (3 foreign keys)', count(*)::text, case when count(*) = 3 then 'OK' else 'STOP' end
  from pg_constraint where conname in ('courts_sport_fkey', 'matches_sport_fkey', 'player_levels_sport_fkey') and contype = 'f'
union all
select 'P4 the guards are on their tables (sports_guard on sports; sport_choice_guard on 5 tables)', count(*)::text, case when count(*) = 6 then 'OK' else 'STOP' end
  from pg_trigger t where not t.tgisinternal and (
    (t.tgname = 'sports_guard' and t.tgrelid = 'public.sports'::regclass)
    or (t.tgname = 'sport_choice_guard' and t.tgrelid in ('public.profiles'::regclass, 'public.coaches'::regclass, 'public.courts'::regclass, 'public.matches'::regclass, 'public.player_levels'::regclass)))
union all
select 'P5 the guard functions: security definer, search_path=public, not callable by anon or signed-in users',
  count(*)::text,
  case when count(*) = 2 and bool_and(p.prosecdef and p.proconfig @> array['search_path=public']
         and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute'))
       then 'OK' else 'STOP' end
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('sports_guard', 'sport_choice_guard')
union all
select 'P6 searches match a sport''s name and aliases (club_discovery, club_day_slots); club_sports is alphabetical',
  (position('unnest(s.aliases)' in coalesce(pg_get_functiondef(to_regprocedure('public.club_discovery(sport,text,text,text)')), '')) > 0)::text || '/'
    || (position('unnest(s2.aliases)' in coalesce(pg_get_functiondef(to_regprocedure('public.club_day_slots(date,sport,text,text,text)')), '')) > 0)::text || '/'
    || (position('order by x.name_en' in coalesce(pg_get_functiondef(to_regprocedure('public.club_sports(uuid)')), '')) > 0)::text,
  case when position('unnest(s.aliases)' in coalesce(pg_get_functiondef(to_regprocedure('public.club_discovery(sport,text,text,text)')), '')) > 0
        and position('unnest(s2.aliases)' in coalesce(pg_get_functiondef(to_regprocedure('public.club_day_slots(date,sport,text,text,text)')), '')) > 0
        and position('order by x.name_en' in coalesce(pg_get_functiondef(to_regprocedure('public.club_sports(uuid)')), '')) > 0 then 'OK' else 'STOP' end
union all
select 'P7 browsing still works signed out: club_discovery, club_day_slots and next_free_slot are callable by anon',
  count(*)::text, case when count(*) = 3 and bool_and(has_function_privilege('anon', p.oid, 'execute')) then 'OK' else 'STOP' end
  from pg_proc p where p.oid in (to_regprocedure('public.club_discovery(sport,text,text,text)'), to_regprocedure('public.club_day_slots(date,sport,text,text,text)'), to_regprocedure('public.next_free_slot(uuid,sport)'))
union all
select 'P8 RLS is still on for sports; its policies are read-all and admin-write',
  (select relrowsecurity::text from pg_class where oid = 'public.sports'::regclass) || ' / ' || coalesce((select string_agg(policyname, ', ' order by policyname) from pg_policies where schemaname = 'public' and tablename = 'sports'), 'none'),
  case when (select relrowsecurity from pg_class where oid = 'public.sports'::regclass)
        and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'sports') = 2 then 'OK' else 'STOP' end;
