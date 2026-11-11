-- Phase 8: player levels 1–10 per sport (Paul's guide, player-levels-v1). Legacy profiles.level (enum) is kept
-- read-only as a hint until the player picks a number; matches get a level range; legacy enum posts keep working.

insert into sports (code, name_en, name_ar, sort_order) values ('badminton', 'Badminton', 'الريشة الطائرة', 70) on conflict (code) do nothing;

-- Beginner 1–3 · Intermediate 4–6 · Advanced 7–10 (the one shared definition; the app mirrors it in src/lib/levels.ts)
create or replace function level_group(p_level int) returns text
language sql immutable as $$
  select case when p_level is null then null when p_level <= 3 then 'beginner' when p_level <= 6 then 'intermediate' else 'advanced' end;
$$;
-- legacy enum → its interval
create or replace function level_range_of(p_level player_level) returns int[]
language sql immutable as $$
  select case p_level when 'beginner' then array[1,3] when 'intermediate' then array[4,6] when 'advanced' then array[7,10] else null end;
$$;

create table player_levels (
  profile_id    uuid not null references profiles(id) on delete cascade,
  sport         sport not null,
  level         int not null check (level between 1 and 10),
  guide_version text not null default 'player-levels-v1',
  updated_at    timestamptz not null default now(),
  primary key (profile_id, sport)
);
alter table player_levels enable row level security;
create policy "player_levels: read own" on player_levels for select to authenticated using (profile_id = auth.uid());
-- writes go through the RPC only (no insert/update/delete policies)

-- set or clear (p_level null) one sport's level for the signed-in player; sport must be one of theirs
create or replace function set_player_level(p_sport sport, p_level int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if p_level is not null and (p_level < 1 or p_level > 10) then raise exception 'bad_level'; end if;
  if p_level is null then
    delete from player_levels where profile_id = auth.uid() and sport = p_sport;
  else
    insert into player_levels (profile_id, sport, level, guide_version, updated_at) values (auth.uid(), p_sport, p_level, 'player-levels-v1', now())
    on conflict (profile_id, sport) do update set level = excluded.level, guide_version = excluded.guide_version, updated_at = now();
  end if;
end $$;
revoke execute on function set_player_level(sport, int) from public, anon;
grant execute on function set_player_level(sport, int) to authenticated;

-- my levels (all sports) for the profile screen
create or replace function my_levels() returns table (sport sport, level int)
language sql stable security definer set search_path = public as $$
  select sport, level from player_levels where profile_id = auth.uid() order by sport;
$$;
revoke execute on function my_levels() from public, anon;
grant execute on function my_levels() to authenticated;

-- Matches: range --------------------------------------------------------------
alter table matches
  add column level_min int check (level_min between 1 and 10),
  add column level_max int check (level_max between 1 and 10),
  add constraint matches_level_range check ((level_min is null) = (level_max is null) and (level_min is null or level_min <= level_max));

drop function if exists post_match(uuid, sport, timestamptz, timestamptz, player_level, int, text, uuid, text);
create or replace function post_match(
  p_club uuid, p_sport sport, p_start timestamptz, p_end timestamptz, p_level_min int, p_level_max int,
  p_players_needed int, p_note text, p_booking uuid, p_join_mode text default 'open'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := gen_random_uuid();
  b bookings%rowtype;
  v_court_sport sport;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if p_booking is not null then
    select * into b from bookings where id = p_booking and player_id = auth.uid() for update;
    if not found or b.status <> 'confirmed' then raise exception 'booking_not_found'; end if;
    select sport into v_court_sport from courts where id = b.court_id;
    if v_court_sport is not null and v_court_sport <> p_sport then raise exception 'sport_mismatch'; end if;
    if exists (select 1 from matches where booking_id = p_booking and status <> 'cancelled') then raise exception 'booking_already_posted'; end if;
    p_club := b.club_id; p_start := b.start_at; p_end := b.end_at;
  end if;
  if p_start is null or p_start <= now() then raise exception 'slot_in_past'; end if;
  if p_end is not null and p_end <= p_start then raise exception 'bad_range'; end if;
  if p_players_needed < 1 or p_players_needed > 20 then raise exception 'bad_players_needed'; end if;
  if p_join_mode not in ('open', 'approval') then raise exception 'bad_join_mode'; end if;
  if length(coalesce(p_note, '')) > 300 then raise exception 'note_too_long'; end if;
  if (p_level_min is null) <> (p_level_max is null) or (p_level_min is not null and (p_level_min < 1 or p_level_max > 10 or p_level_min > p_level_max)) then raise exception 'bad_level_range'; end if;
  insert into matches (id, club_id, sport, organizer_id, start_at, end_at, level_min, level_max, players_needed, note, booking_id, join_mode)
  values (v_id, p_club, p_sport, auth.uid(), p_start, p_end, p_level_min, p_level_max, p_players_needed, nullif(trim(p_note), ''), p_booking, p_join_mode);
  return v_id;
exception when unique_violation then
  raise exception 'booking_already_posted';
end $$;
revoke execute on function post_match(uuid, sport, timestamptz, timestamptz, int, int, int, text, uuid, text) from public, anon;
grant execute on function post_match(uuid, sport, timestamptz, timestamptz, int, int, int, text, uuid, text) to authenticated;

drop function if exists update_match(uuid, int, player_level, text, text);
create or replace function update_match(p_match uuid, p_players_needed int, p_level_min int, p_level_max int, p_note text, p_join_mode text) returns void
language plpgsql security definer set search_path = public as $$
declare m matches%rowtype; n int;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if m.organizer_id <> auth.uid() then raise exception 'forbidden'; end if;
  if m.status = 'cancelled' or m.start_at <= now() then raise exception 'match_closed'; end if;
  if p_players_needed < 1 or p_players_needed > 20 then raise exception 'bad_players_needed'; end if;
  if p_join_mode not in ('open', 'approval') then raise exception 'bad_join_mode'; end if;
  if length(coalesce(p_note, '')) > 300 then raise exception 'note_too_long'; end if;
  if (p_level_min is null) <> (p_level_max is null) or (p_level_min is not null and (p_level_min < 1 or p_level_max > 10 or p_level_min > p_level_max)) then raise exception 'bad_level_range'; end if;
  select count(*) into n from match_players where match_id = p_match and status = 'accepted';
  if p_players_needed < n then raise exception 'below_accepted'; end if;
  update matches set players_needed = p_players_needed, level_min = p_level_min, level_max = p_level_max, level = null,
    note = nullif(trim(p_note), ''), join_mode = p_join_mode where id = p_match;
  if m.status = 'open' and n >= p_players_needed then
    update matches set status = 'closed', closed_at = now(), closed_reason = 'full' where id = p_match;
  elsif m.status = 'closed' and m.closed_reason = 'full' and n < p_players_needed then
    update matches set status = 'open', closed_at = null, closed_reason = null where id = p_match;
  end if;
end $$;
revoke execute on function update_match(uuid, int, int, int, text, text) from public, anon;
grant execute on function update_match(uuid, int, int, int, text, text) to authenticated;

-- Effective range of a match: explicit range, else the legacy group's interval, else open
create or replace function match_level_bounds(m matches) returns int[]
language sql immutable as $$
  select case when m.level_min is not null then array[m.level_min, m.level_max] else level_range_of(m.level) end;
$$;

-- match_board: numeric range + legacy flag + my level for that sport
drop function if exists match_board(uuid, int);
create or replace function match_board(p_club uuid, p_days int)
returns table (
  match_id uuid, club_id uuid, club_name text, club_slug text, sport sport, start_at timestamptz, end_at timestamptz,
  level_min int, level_max int, level_legacy boolean, my_level int,
  players_needed int, joined int, pending int, status match_status, note text, join_mode text,
  organizer_id uuid, organizer_name text, my_status text, i_organize boolean, booking_id uuid, court_name text
)
language sql stable security definer set search_path = public as $$
  select m.id, m.club_id, c.name, c.slug, m.sport, m.start_at, m.end_at,
         (match_level_bounds(m))[1], (match_level_bounds(m))[2], m.level_min is null and m.level is not null,
         (select pl.level from player_levels pl where pl.profile_id = auth.uid() and pl.sport = m.sport),
         m.players_needed,
         (select count(*) from match_players mp where mp.match_id = m.id and mp.status = 'accepted')::int,
         (select count(*) from match_players mp where mp.match_id = m.id and mp.status = 'pending')::int,
         m.status, m.note, m.join_mode, m.organizer_id, o.name,
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
    and (m.status = 'open' or m.organizer_id = auth.uid() or exists (select 1 from match_players mp where mp.match_id = m.id and mp.profile_id = auth.uid()))
  order by m.start_at;
$$;
revoke execute on function match_board(uuid, int) from public, anon;
grant execute on function match_board(uuid, int) to authenticated;

-- open_matches: p_level (enum) replaced by p_level_fit: null = all; 'mine' = only ranges that include my level
--   (matches with no range always qualify; players with no level see everything)
drop function if exists open_matches(sport, player_level, timestamptz, timestamptz, text, text, int);
create or replace function open_matches(
  p_sport sport default null, p_fit text default null, p_from timestamptz default null, p_to timestamptz default null,
  p_governorate text default null, p_district text default null, p_limit int default 50
)
returns table (
  match_id uuid, club_id uuid, club_name text, club_slug text, town text, sport sport, start_at timestamptz, end_at timestamptz,
  level_min int, level_max int, level_legacy boolean, my_level int, players_needed int, joined int, note text, organizer_name text, join_mode text, i_joined boolean, booking_id uuid, court_name text
)
language sql stable security definer set search_path = public as $$
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
    and m.start_at > coalesce(p_from, now()) and m.start_at < coalesce(p_to, now() + interval '14 days')
    and (p_sport is null or m.sport = p_sport)
    and (p_fit is distinct from 'mine' or pl.level is null or match_level_bounds(m) is null
         or (pl.level between (match_level_bounds(m))[1] and (match_level_bounds(m))[2]))
    and (p_governorate is null or d.governorate_code = p_governorate)
    and (p_district is null or d.code = p_district)
  order by m.start_at
  limit least(coalesce(p_limit, 50), 100);
$$;
revoke execute on function open_matches(sport, text, timestamptz, timestamptz, text, text, int) from public, anon;
grant execute on function open_matches(sport, text, timestamptz, timestamptz, text, text, int) to authenticated;

-- participants: numeric level for the match's sport (legacy word when no number)
drop function if exists match_participants(uuid);
create or replace function match_participants(p_match uuid)
returns table (profile_id uuid, name text, level int, level_legacy player_level, is_organizer boolean, status text)
language sql stable security definer set search_path = public as $$
  select p.id, p.name, pl.level, case when pl.level is null then p.level end, p.id = m.organizer_id, coalesce(mp.status, 'accepted')
  from matches m
  join lateral (
    select m.organizer_id as pid, null::text as st
    union all
    select x.profile_id, x.status from match_players x where x.match_id = m.id and x.status in ('accepted', 'pending')
  ) ids on true
  join profiles p on p.id = ids.pid
  left join player_levels pl on pl.profile_id = p.id and pl.sport = m.sport
  left join match_players mp on mp.match_id = m.id and mp.profile_id = ids.pid
  where m.id = p_match and auth.uid() is not null
    and (m.organizer_id = auth.uid()
         or exists (select 1 from match_players y where y.match_id = m.id and y.profile_id = auth.uid() and y.status = 'accepted'))
    and (m.organizer_id = auth.uid() or coalesce(mp.status, 'accepted') = 'accepted')
  order by (p.id = m.organizer_id) desc, coalesce(mp.status, 'accepted'), p.name;
$$;
revoke execute on function match_participants(uuid) from public, anon;
grant execute on function match_participants(uuid) to authenticated;
