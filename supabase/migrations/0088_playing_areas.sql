-- 0088: where a player usually plays, and where they last browsed — kept on the account, so a player who plays in
-- Beirut in the week and Batroun or Tripoli at the weekend finds both on any device without searching again.
--
--  * player_areas: up to 10 areas per player, in the player's order. An area is a governorate, optionally narrowed to
--    a district, optionally to a town in that district ("North Lebanon", "Batroun district", "Batroun").
--  * player_prefs: whether the optional first-use question ("Where do you usually play?") has been answered or
--    skipped — once either happens it is never asked again, on any device — and the last area browsed.
--  * Nothing here is a position: no coordinates, no GPS. Areas are places the player chose from the list.
--  * Players read only their own rows; every write goes through the functions below (validated, per-player lock).
--    Rows go with the account. If 0086 (account closing) exists, closed accounts cannot change them.

create table if not exists player_areas (
  profile_id       uuid not null references profiles(id) on delete cascade,
  position         smallint not null check (position between 1 and 10),
  governorate_code text not null references governorates(code),
  district_code    text references districts(code),
  town_id          uuid references towns(id) on delete cascade,
  created_at       timestamptz not null default now(),
  primary key (profile_id, position),
  constraint player_areas_town_needs_district check (town_id is null or district_code is not null)
);
create unique index if not exists player_areas_unique on player_areas
  (profile_id, governorate_code, coalesce(district_code, ''), coalesce(town_id::text, ''));

create table if not exists player_prefs (
  profile_id       uuid primary key references profiles(id) on delete cascade,
  areas_asked_at   timestamptz,     -- the first-use question was answered or skipped: never asked again
  last_governorate text references governorates(code),
  last_district    text references districts(code),
  last_town        uuid references towns(id) on delete set null,
  updated_at       timestamptz not null default now()
);

alter table player_areas enable row level security;
alter table player_prefs enable row level security;
drop policy if exists "player_areas: own read" on player_areas;
create policy "player_areas: own read" on player_areas for select to authenticated using (profile_id = auth.uid());
drop policy if exists "player_prefs: own read" on player_prefs;
create policy "player_prefs: own read" on player_prefs for select to authenticated using (profile_id = auth.uid());
revoke all on player_areas, player_prefs from public, anon, authenticated;
grant select on player_areas, player_prefs to authenticated;

-- One area, checked: the district belongs to the governorate, the town to the district. Raises bad_area otherwise.
create or replace function playing_area_checked(p_gov text, p_district text, p_town uuid)
returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if p_gov is null or not exists (select 1 from governorates where code = p_gov) then raise exception 'bad_area'; end if;
  if p_district is not null and not exists (select 1 from districts where code = p_district and governorate_code = p_gov) then
    raise exception 'bad_area';
  end if;
  if p_town is not null and (p_district is null or not exists (select 1 from towns where id = p_town and district_code = p_district)) then
    raise exception 'bad_area';
  end if;
end $$;
revoke all on function playing_area_checked(text, text, uuid) from public, anon, authenticated;

-- Everything the screens need, in one call: the question's state, the areas in order (with names), the last area.
create or replace function my_playing_prefs()
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'asked', coalesce((select areas_asked_at is not null from player_prefs where profile_id = auth.uid()), false),
    'areas', coalesce((
      select jsonb_agg(jsonb_build_object(
               'governorate', a.governorate_code, 'district', a.district_code, 'town', a.town_id,
               'label', coalesce(t.name_en, d.name_en, g.name_en),
               'within', case when t.id is not null then d.name_en when d.code is not null then g.name_en end)
             order by a.position)
        from player_areas a
        join governorates g on g.code = a.governorate_code
        left join districts d on d.code = a.district_code
        left join towns t on t.id = a.town_id
       where a.profile_id = auth.uid()), '[]'::jsonb),
    'last', (select case when p.last_governorate is null then null
                         else jsonb_build_object('governorate', p.last_governorate, 'district', p.last_district, 'town', p.last_town,
                                                 'label', coalesce(t.name_en, d.name_en, g.name_en)) end
               from player_prefs p
               left join governorates g on g.code = p.last_governorate
               left join districts d on d.code = p.last_district
               left join towns t on t.id = p.last_town
              where p.profile_id = auth.uid()))
  where auth.uid() is not null;
$$;
revoke all on function my_playing_prefs() from public, anon;
grant execute on function my_playing_prefs() to authenticated;

-- Replace the player's areas with this list (in order). Duplicates are dropped, keeping the first. Answers the
-- first-use question for good. An empty list is allowed ("anywhere"). Returns my_playing_prefs().
create or replace function set_playing_areas(p_areas jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  a jsonb; n int := 0; g text; d text; t uuid;
begin
  if me is null then raise exception 'not_authenticated'; end if;
  if p_areas is null or jsonb_typeof(p_areas) <> 'array' then raise exception 'bad_request'; end if;
  if jsonb_array_length(p_areas) > 10 then raise exception 'too_many_areas'; end if;
  perform 1 from profiles where id = me for update;          -- one replacement at a time per player
  delete from player_areas where profile_id = me;
  for a in select value from jsonb_array_elements(p_areas) loop
    if jsonb_typeof(a) <> 'object' then raise exception 'bad_area'; end if;
    g := nullif(a->>'governorate', ''); d := nullif(a->>'district', '');
    begin t := nullif(a->>'town', '')::uuid; exception when invalid_text_representation then raise exception 'bad_area'; end;
    perform playing_area_checked(g, d, t);
    if exists (select 1 from player_areas where profile_id = me and governorate_code = g
                and coalesce(district_code, '') = coalesce(d, '') and coalesce(town_id::text, '') = coalesce(t::text, '')) then
      continue;
    end if;
    n := n + 1;
    insert into player_areas (profile_id, position, governorate_code, district_code, town_id) values (me, n, g, d, t);
  end loop;
  insert into player_prefs (profile_id, areas_asked_at) values (me, now())
  on conflict (profile_id) do update set areas_asked_at = coalesce(player_prefs.areas_asked_at, now()), updated_at = now();
  return my_playing_prefs();
end $$;
revoke all on function set_playing_areas(jsonb) from public, anon;
grant execute on function set_playing_areas(jsonb) to authenticated;

-- "Not now" on the first-use question: never asked again; the player can still add areas whenever they want.
create or replace function dismiss_areas_question()
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  insert into player_prefs (profile_id, areas_asked_at) values (auth.uid(), now())
  on conflict (profile_id) do update set areas_asked_at = coalesce(player_prefs.areas_asked_at, now()), updated_at = now();
end $$;
revoke all on function dismiss_areas_question() from public, anon;
grant execute on function dismiss_areas_question() to authenticated;

-- The area the player last browsed (all null = "All Lebanon"). Validated like an area. Idempotent.
create or replace function set_last_area(p_governorate text, p_district text default null, p_town uuid default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if p_governorate is null then
    if p_district is not null or p_town is not null then raise exception 'bad_area'; end if;
  else
    perform playing_area_checked(p_governorate, p_district, p_town);
  end if;
  insert into player_prefs (profile_id, last_governorate, last_district, last_town)
  values (auth.uid(), p_governorate, p_district, p_town)
  on conflict (profile_id) do update set last_governorate = excluded.last_governorate, last_district = excluded.last_district,
    last_town = excluded.last_town, updated_at = now()
  where (player_prefs.last_governorate, player_prefs.last_district, player_prefs.last_town)
        is distinct from (excluded.last_governorate, excluded.last_district, excluded.last_town);
end $$;
revoke all on function set_last_area(text, text, uuid) from public, anon;
grant execute on function set_last_area(text, text, uuid) to authenticated;

-- Club map points: both or neither. NOT VALID: enforced from now on; existing rows are reported by the read-only
-- coordinates audit (supabase/tests/favourites/club_coordinates_audit.sql), not rewritten here.
alter table clubs drop constraint if exists clubs_map_point_pair;
alter table clubs add constraint clubs_map_point_pair check ((lat is null) = (lng is null)) not valid;

-- 0086 compatibility (see 0087).
do $$
declare tb text;
begin
  if exists (select 1 from pg_proc where proname = 'refuse_writes_by_closed_account') then
    foreach tb in array array['player_areas', 'player_prefs'] loop
      execute format('drop trigger if exists closed_account_lockout on %I', tb);
      execute format('create trigger closed_account_lockout before insert or update or delete on %I '
                  || 'for each statement execute function refuse_writes_by_closed_account()', tb);
    end loop;
  end if;
end $$;
