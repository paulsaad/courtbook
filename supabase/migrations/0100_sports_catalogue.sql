-- DRAFT (not numbered, not applied anywhere): an admin-managed sports catalogue, table tennis, alphabetical sports.
-- Overnight assignment of 26 Nov, priority 6 (F14 table tennis, F15 admins manage sports, F16 alphabetical and only
-- the club's own sports). Apply locally with EXTRA_MIGRATIONS=docs/sports/sql/sports_catalogue.draft.sql (run.sh).
--
-- Today a sport is a Postgres ENUM (0001, 0028, 0040): adding one needs a migration (ALTER TYPE … ADD VALUE). The
-- `sports` table already holds names, order and an active flag, and admins may already write it (0028 RLS), but a new
-- row is useless until the enum has the value. This draft makes the table the catalogue:
--
--   1. `sport` becomes a DOMAIN over text (a stable lower-case code: ^[a-z][a-z0-9_]{1,30}$). Existing codes are
--      unchanged, so every stored value, API payload and app build keeps working. Every column keeps its name.
--   2. Every single-valued sport column references the catalogue (FOREIGN KEY → sports.code): courts, matches,
--      player_levels. The two arrays (profiles.sports, coaches.sports) are checked by a trigger (a code must exist; a NEW
--      code must be active). A sport in use cannot be deleted (FK, and a guard for the arrays): deactivate it instead.
--   3. A sport's code never changes once created (a guard). Names, aliases and the active flag are the admin's to edit.
--   4. Deactivating a sport hides it from choices (discovery filters, new courts, new games, profile and coach choices)
--      and NEVER touches history: courts, bookings, games and levels that use it stay exactly as they are. A court of a
--      deactivated sport keeps working (deactivate the court to stop bookings).
--   5. Only an admin writes the catalogue (existing RLS: "sports: admin"). Players and club staff cannot: staff choose
--      among active sports for their courts, they do not invent global ones.
--   6. Table tennis is added (code table_tennis), with "ping pong" as an alias. Discovery's free-text search also
--      matches a sport's name and aliases ("ping pong" finds clubs with table tennis courts).
--   7. club_sports lists a club's sports alphabetically by display name; the app and website order every sport list by
--      display name (client change in the same draft).
--
-- How: functions whose signature uses the enum are captured (definition and grants) BEFORE the enum is renamed, dropped,
-- and re-created from the captured text against the new domain, with exactly the same grants. Nothing else about them
-- changes. Run once; refuses if already applied.

do $$
begin
  if exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typname = 'sport' and t.typtype = 'd') then
    raise exception 'sports catalogue (0100) already applied';
  end if;
end $$;

-- ------------------------------------------------------------------ 1. capture every function that uses the enum
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

-- ------------------------------------------------------------------ 2. the enum becomes a domain over text
alter type sport rename to sport_enum_retired;
create domain sport as text check (value ~ '^[a-z][a-z0-9_]{1,30}$');

alter table sports        alter column code   type sport   using code::text;
alter table courts        alter column sport  type sport   using sport::text;
alter table matches       alter column sport  type sport   using sport::text;
alter table player_levels alter column sport  type sport   using sport::text;
alter table profiles      alter column sports drop default;
alter table profiles      alter column sports type sport[] using sports::text[];
alter table profiles      alter column sports set default '{}';
alter table coaches       alter column sports drop default;
alter table coaches       alter column sports type sport[] using sports::text[];
alter table coaches       alter column sports set default '{}';

-- ------------------------------------------------------------------ 3. re-create the functions, same text, same grants
-- review of 412156a (B1): bodies are not checked while re-creating (as pg_dump restores), so the order of the
-- functions cannot matter (club_discovery calls next_free_slot and club_sports); a fixed order besides
do $$
declare f record; g record;
begin
  perform set_config('check_function_bodies', 'off', true);
  for f in select * from _sport_fns order by sig loop
    execute f.def;
    -- whatever default privileges gave the re-created function is removed before the captured grants go back (nit)
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
    for g in select (aclexplode(f.proacl)).* loop
      if g.privilege_type = 'EXECUTE' then
        execute format('grant execute on function %s to %s', f.sig,
          case when g.grantee = 0 then 'public' else quote_ident((select rolname from pg_roles where oid = g.grantee)) end);
      end if;
    end loop;
    -- a function with no ACL (null) had the default: EXECUTE for public
    if f.proacl is null then execute format('grant execute on function %s to public', f.sig); end if;
  end loop;
  perform set_config('check_function_bodies', 'on', true);
end $$;

drop type sport_enum_retired;

-- ------------------------------------------------------------------ 4. the catalogue
alter table sports add column if not exists aliases text[] not null default '{}';
alter table sports drop constraint if exists sports_names_present;
alter table sports add constraint sports_names_present check (btrim(name_en) <> '');
-- CourtBook is English only (Paul, 26 Nov): a new sport needs no Arabic name. The column (0029) and the existing
-- sports' values are left as they are; it simply stops being required. Nothing reads it for sports.
alter table sports alter column name_ar drop not null;
alter table sports drop constraint if exists sports_names_trimmed;
alter table sports add constraint sports_names_trimmed check (name_en = btrim(name_en));   -- review nit: " Zumba"
create unique index if not exists sports_name_en_unique on sports (lower(name_en));
-- Sports are listed by name (F16); sort_order no longer orders anything. A default lets an admin add a sport in the
-- Supabase table editor with only a code and a name.
alter table sports alter column sort_order set default 1000;

insert into sports (code, name_en, name_ar, sort_order, active, aliases)
values ('table_tennis', 'Table tennis', null, 80, true, '{"ping pong","ping-pong","pingpong"}')
on conflict (code) do nothing;

-- every single-valued use references the catalogue
alter table courts        add constraint courts_sport_fkey        foreign key (sport) references sports(code);
alter table matches       add constraint matches_sport_fkey       foreign key (sport) references sports(code);
alter table player_levels add constraint player_levels_sport_fkey foreign key (sport) references sports(code);

-- a code is permanent; a sport in use is deactivated, never deleted
create or replace function sports_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.code is distinct from old.code then raise exception 'sport_code_permanent'; end if;
  if tg_op = 'DELETE' then
    if exists (select 1 from profiles where old.code = any(sports)) or exists (select 1 from coaches where old.code = any(sports)) then
      raise exception 'sport_in_use';
    end if;
    return old;
  end if;
  return new;
end $$;
drop trigger if exists sports_guard on sports;
create trigger sports_guard before update or delete on sports for each row execute function sports_guard();
revoke execute on function sports_guard() from public, anon, authenticated;  -- fires as a trigger only

-- a NEW use of a sport must name an active catalogue entry; existing uses are never re-checked (history is kept)
create or replace function sport_choice_guard() returns trigger language plpgsql security definer set search_path = public as $$
declare v_new text[]; v_old text[]; c text;
begin
  if tg_table_name in ('profiles', 'coaches') then
    v_new := coalesce(new.sports::text[], '{}');
    v_old := case when tg_op = 'UPDATE' then coalesce(old.sports::text[], '{}') else '{}' end;
    -- review of 412156a (B2): an empty element is never a sport, and must not switch the check off ("is not true")
    if array_position(v_new, null) is not null then raise exception 'unknown_sport'; end if;
    foreach c in array v_new loop
      if (c = any(v_old)) is not true then
        -- lock first, then decide (review SF4, both orders): a delete that started earlier makes this wait and then
        -- find nothing (unknown_sport); a delete that starts later waits for this row and then sees it in use
        perform 1 from sports where code = c for key share;
        if not found then raise exception 'unknown_sport'; end if;
        if not exists (select 1 from sports where code = c and active) then raise exception 'sport_inactive'; end if;
      end if;
    end loop;
    return new;
  end if;
  -- courts, matches, player_levels: a new row, or a changed sport
  if tg_op = 'INSERT' or new.sport is distinct from old.sport then
    if not exists (select 1 from sports where code = new.sport) then raise exception 'unknown_sport'; end if;
    if not exists (select 1 from sports where code = new.sport and active) then raise exception 'sport_inactive'; end if;
  end if;
  return new;
end $$;
drop trigger if exists sport_choice_guard on profiles;
drop trigger if exists sport_choice_guard on coaches;
drop trigger if exists sport_choice_guard on courts;
drop trigger if exists sport_choice_guard on matches;
create trigger sport_choice_guard before insert or update of sports on profiles for each row execute function sport_choice_guard();
create trigger sport_choice_guard before insert or update of sports on coaches  for each row execute function sport_choice_guard();
create trigger sport_choice_guard before insert or update of sport  on courts   for each row execute function sport_choice_guard();
create trigger sport_choice_guard before insert or update of sport  on matches  for each row execute function sport_choice_guard();
-- review 66-4 (27 Nov): a level may be set only for an active sport. set_player_level upserts, and a BEFORE INSERT
-- trigger fires before ON CONFLICT, so changing an existing level of a deactivated sport is refused too; the stored
-- level is kept as it is (history), and clearing it (delete) still works. An unknown code is refused as
-- 'unknown_sport' instead of the raw foreign-key error.
drop trigger if exists sport_choice_guard on player_levels;
create trigger sport_choice_guard before insert or update of sport on player_levels for each row execute function sport_choice_guard();
revoke execute on function sport_choice_guard() from public, anon, authenticated;  -- fires as a trigger only

-- ------------------------------------------------------------------ 5. alphabetical, and only the club's own sports
create or replace function club_sports(p_club uuid) returns sport[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(x.code order by x.name_en), '{}')
  from (select distinct k.sport as code, coalesce(s.name_en, k.sport) as name_en
        from courts k left join sports s on s.code = k.sport
        where k.club_id = p_club and k.active and club_id_visible_to_me(p_club)) x;
$$;

-- discovery: the free-text search also matches a sport the club offers, by name or alias ("ping pong")
do $$
declare d text;
begin
  d := pg_get_functiondef('club_discovery(sport,text,text,text)'::regprocedure);
  if position('t.name_ar like ''%'' || q.text || ''%'')' in d) = 0 then raise exception 'club_discovery changed: review the search clause'; end if;
  d := replace(d, 't.name_ar like ''%'' || q.text || ''%'')',
    't.name_ar like ''%'' || q.text || ''%'''
    || ' or exists (select 1 from courts k join sports s on s.code = k.sport where k.club_id = c.id and k.active and s.active'
    || ' and (s.name_en ilike ''%'' || q.text || ''%'''
    || ' or exists (select 1 from unnest(s.aliases) a where a ilike ''%'' || q.text || ''%''))))');
  execute d;
  -- review of 412156a (SF1): the Courts search (club_day_slots) matches sports the same way
  d := pg_get_functiondef('club_day_slots(date,sport,text,text,text)'::regprocedure);
  if position('tw.name_ar like ''%'' || q || ''%'')' in d) = 0 then raise exception 'club_day_slots changed: review the search clause'; end if;
  d := replace(d, 'tw.name_ar like ''%'' || q || ''%'')',
    'tw.name_ar like ''%'' || q || ''%'''
    || ' or exists (select 1 from courts k2 join sports s2 on s2.code = k2.sport where k2.club_id = cl.id and k2.active and s2.active'
    || ' and (s2.name_en ilike ''%'' || q || ''%'''
    || ' or exists (select 1 from unnest(s2.aliases) a where a ilike ''%'' || q || ''%''))))');
  execute d;
end $$;
