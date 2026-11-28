-- Rollback of 0100 (supabase/migrations/0100_sports_catalogue.sql). Run it as ONE transaction (psql -1 / the workflow):
-- its refusals come after some of its statements. Returns the schema to what it was before 0100 exactly
-- (checked by supabase/tests/sports/sports_catalogue_rollback.sh: schema fingerprint identical to a plain build).
--
-- REFUSES, changing nothing, when a sport the old enum does not know is in use anywhere (a court, a game, a level, a
-- player's or coach's sports): rolling back would have to delete or rewrite that data. Deactivate and clear it first,
-- or roll forward instead. An unused new catalogue row (e.g. table tennis with no court) is removed.
-- club_sports is restored to its 0093 definition (embedded below); club_discovery has exactly the clause the up
-- script inserted removed (refuses if that clause is not found, rather than guessing).

do $$
declare known text[] := array['padel','tennis','other','football','basketball','volleyball','squash','badminton']; bad text;
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typname = 'sport' and t.typtype = 'd') then
    raise exception 'sports catalogue (0100) is not applied: nothing to roll back';
  end if;
  select string_agg(distinct x, ',') into bad from (
    select sport::text x from courts union all select sport::text from matches union all select sport::text from player_levels
    union all select unnest(sports)::text from profiles union all select unnest(sports)::text from coaches) u
  where x <> all(known);
  if bad is not null then raise exception 'rollback_blocked: sport(s) % in use; deactivate and clear them first, or roll forward', bad; end if;
end $$;

-- 1. the catalogue rules
drop trigger if exists sport_choice_guard on profiles;
drop trigger if exists sport_choice_guard on coaches;
drop trigger if exists sport_choice_guard on courts;
drop trigger if exists sport_choice_guard on matches;
drop trigger if exists sport_choice_guard on player_levels;
drop trigger if exists sports_guard on sports;
drop function if exists sport_choice_guard();
drop function if exists sports_guard();
alter table courts        drop constraint if exists courts_sport_fkey;
alter table matches       drop constraint if exists matches_sport_fkey;
alter table player_levels drop constraint if exists player_levels_sport_fkey;
delete from sports where code <> all(array['padel','tennis','other','football','basketball','volleyball','squash','badminton']);
drop index if exists sports_name_en_unique;
alter table sports drop constraint if exists sports_names_present;
alter table sports drop constraint if exists sports_names_trimmed;
alter table sports drop column if exists aliases;
alter table sports alter column sort_order drop default;
do $$
begin
  if exists (select 1 from sports where name_ar is null) then   -- review nit: a clear refusal, not the raw error
    raise exception 'rollback_blocked: sport(s) % have no Arabic name, which the old schema requires; add one first',
      (select string_agg(code, ', ' order by code) from sports where name_ar is null);
  end if;
end $$;
alter table sports alter column name_ar set not null;

-- 2. capture every function whose signature uses the domain (definition and grants), and drop it
create temp table _sport_fns on commit drop as
  select p.oid, p.oid::regprocedure::text as sig, pg_get_functiondef(p.oid) as def, p.proacl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and ( 'public.sport'::regtype = any(p.proargtypes::oid[]) or 'public.sport[]'::regtype = any(p.proargtypes::oid[])
       or 'public.sport'::regtype = any(coalesce(p.proallargtypes, '{}')) or 'public.sport[]'::regtype = any(coalesce(p.proallargtypes, '{}'))
       or p.prorettype in ('public.sport'::regtype, 'public.sport[]'::regtype));
do $$
declare f record;
begin
  for f in select * from _sport_fns loop execute format('drop function %s', f.sig); end loop;
end $$;

-- 3. the domain becomes the enum again, labels in their original order
create type sport_enum_restored as enum ('padel','tennis','other','football','basketball','volleyball','squash','badminton');
alter table sports        alter column code   type sport_enum_restored using code::text::sport_enum_restored;
alter table courts        alter column sport  type sport_enum_restored using sport::text::sport_enum_restored;
alter table matches       alter column sport  type sport_enum_restored using sport::text::sport_enum_restored;
alter table player_levels alter column sport  type sport_enum_restored using sport::text::sport_enum_restored;
alter table profiles      alter column sports drop default;
alter table profiles      alter column sports type sport_enum_restored[] using sports::text[]::sport_enum_restored[];
alter table coaches       alter column sports drop default;
alter table coaches       alter column sports type sport_enum_restored[] using sports::text[]::sport_enum_restored[];
drop domain sport;
alter type sport_enum_restored rename to sport;
alter table profiles      alter column sports set default '{}'::sport[];
alter table coaches       alter column sports set default '{}'::sport[];

-- 4. re-create the functions from their captured text, with the same grants. club_discovery without the inserted
--    clause; club_sports at its 0093 definition.
do $$
declare f record; g record; d text; prev_bodies text;
  inserted text := ' or exists (select 1 from courts k join sports s on s.code = k.sport where k.club_id = c.id and k.active and s.active'
    || ' and (s.name_en ilike ''%'' || q.text || ''%'''
    || ' or exists (select 1 from unnest(s.aliases) a where a ilike ''%'' || q.text || ''%'')))';
  inserted_slots text := ' or exists (select 1 from courts k2 join sports s2 on s2.code = k2.sport where k2.club_id = cl.id and k2.active and s2.active'
    || ' and (s2.name_en ilike ''%'' || q || ''%'''
    || ' or exists (select 1 from unnest(s2.aliases) a where a ilike ''%'' || q || ''%'')))';
begin
  prev_bodies := current_setting('check_function_bodies');
  perform set_config('check_function_bodies', 'off', true);   -- as 0100 (B1): the order cannot matter
  for f in select * from _sport_fns order by sig loop
    -- the enum's defaults come back as written before 0100 (pg_get_functiondef shows the domain-era cast otherwise)
    d := replace(f.def, '(NULL::text)::sport', 'NULL::sport');
    if f.sig like 'club_day_slots(%' then
      if position(inserted_slots in d) = 0 then raise exception 'club_day_slots changed since 0100: restore it by hand'; end if;
      d := replace(d, inserted_slots, '');
    end if;
    if f.sig like 'club_discovery(%' then
      if position(inserted in d) = 0 then raise exception 'club_discovery changed since 0100: restore it by hand'; end if;
      d := replace(d, inserted, '');
    elsif f.sig like 'club_sports(%' then
      d := $orig$
CREATE OR REPLACE FUNCTION public.club_sports(p_club uuid)
 RETURNS sport[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(array_agg(distinct c.sport order by c.sport), '{}') from courts c where c.club_id = p_club and c.active and club_id_visible_to_me(p_club);
$function$
$orig$;
    end if;
    execute d;
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
    for g in select (aclexplode(f.proacl)).* loop
      if g.privilege_type = 'EXECUTE' then
        execute format('grant execute on function %s to %s', f.sig,
          case when g.grantee = 0 then 'public' else quote_ident((select rolname from pg_roles where oid = g.grantee)) end);
      end if;
    end loop;
    if f.proacl is null then execute format('grant execute on function %s to public', f.sig); end if;
  end loop;
  perform set_config('check_function_bodies', prev_bodies, true);
end $$;
