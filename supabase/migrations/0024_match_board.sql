-- Phase 5: match board. Post "looking for players", others join/leave, organizer closes.
-- Optional link to one of the organizer's confirmed court bookings (then club/time come from it).

alter table matches add column if not exists end_at timestamptz;
alter table matches add column if not exists closed_at timestamptz;
alter table matches alter column players_needed set default 3;
-- organizer counts as a player; players_needed = how many others are wanted
create index if not exists matches_open_idx on matches (start_at) where status = 'open';
create index if not exists match_players_profile_idx on match_players (profile_id);

-- Writes go through RPCs (atomic capacity check); drop the broad organizer policy for insert/update,
-- keep reads and organizer delete.
drop policy if exists "matches: organizer" on matches;
drop policy if exists "match_players: join" on match_players;
drop policy if exists "match_players: leave" on match_players;
create policy "matches: organizer delete" on matches for delete using (organizer_id = auth.uid() or is_admin());

create or replace function post_match(
  p_club uuid, p_sport sport, p_start timestamptz, p_end timestamptz, p_level player_level,
  p_players_needed int, p_note text, p_booking uuid
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := gen_random_uuid();
  b bookings%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if p_booking is not null then
    select * into b from bookings where id = p_booking and player_id = auth.uid() and status = 'confirmed';
    if not found then raise exception 'booking_not_found'; end if;
    p_club := b.club_id; p_start := b.start_at; p_end := b.end_at;
  end if;
  if p_start is null or p_start <= now() then raise exception 'slot_in_past'; end if;
  if p_end is not null and p_end <= p_start then raise exception 'bad_range'; end if;
  if p_players_needed < 1 or p_players_needed > 20 then raise exception 'bad_players_needed'; end if;
  insert into matches (id, club_id, sport, organizer_id, start_at, end_at, level, players_needed, note, booking_id)
  values (v_id, p_club, p_sport, auth.uid(), p_start, p_end, p_level, p_players_needed, nullif(trim(p_note), ''), p_booking);
  return v_id;
end $$;
revoke execute on function post_match(uuid, sport, timestamptz, timestamptz, player_level, int, text, uuid) from public, anon;
grant execute on function post_match(uuid, sport, timestamptz, timestamptz, player_level, int, text, uuid) to authenticated;

create or replace function join_match(p_match uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m matches%rowtype; n int;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into m from matches where id = p_match for update;      -- serializes joins per match
  if not found then raise exception 'not_found'; end if;
  if m.status <> 'open' or m.start_at <= now() then raise exception 'match_closed'; end if;
  if m.organizer_id = auth.uid() then raise exception 'organizer_cannot_join'; end if;
  select count(*) into n from match_players where match_id = p_match;
  if n >= m.players_needed then raise exception 'match_full'; end if;
  insert into match_players (match_id, profile_id) values (p_match, auth.uid()) on conflict do nothing;
  if n + 1 >= m.players_needed then
    update matches set status = 'closed', closed_at = now() where id = p_match;   -- full → closed automatically
  end if;
end $$;
revoke execute on function join_match(uuid) from public, anon;
grant execute on function join_match(uuid) to authenticated;

create or replace function leave_match(p_match uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m matches%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if m.start_at <= now() then raise exception 'match_started'; end if;
  delete from match_players where match_id = p_match and profile_id = auth.uid();
  -- reopen if it had closed because it was full (not if the organizer closed it)
  if m.status = 'closed' and m.closed_at is not null and (select count(*) from match_players where match_id = p_match) < m.players_needed
     and not exists (select 1 from matches x where x.id = p_match and x.status = 'cancelled') then
    update matches set status = 'open', closed_at = null where id = p_match and status = 'closed';
  end if;
end $$;
revoke execute on function leave_match(uuid) from public, anon;
grant execute on function leave_match(uuid) to authenticated;

-- organizer closes (enough players found elsewhere) or cancels (match off)
create or replace function set_match_status(p_match uuid, p_status match_status) returns void
language plpgsql security definer set search_path = public as $$
declare m matches%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if m.organizer_id <> auth.uid() and not is_admin() then raise exception 'forbidden'; end if;
  if p_status = 'open' and m.status = 'cancelled' then raise exception 'cannot_reopen'; end if;
  update matches set status = p_status, closed_at = case when p_status = 'open' then null else now() end where id = p_match;
end $$;
revoke execute on function set_match_status(uuid, match_status) from public, anon;
grant execute on function set_match_status(uuid, match_status) to authenticated;

-- Board: upcoming matches, optionally one club; names of organizer (always) and joined players
-- (only to participants; others see counts). player_names() already scopes by shared match.
create or replace function match_board(p_club uuid, p_days int)
returns table (
  match_id uuid, club_id uuid, club_name text, club_slug text, sport sport, start_at timestamptz, end_at timestamptz,
  level player_level, players_needed int, joined int, status match_status, note text,
  organizer_id uuid, organizer_name text, i_joined boolean, i_organize boolean, booking_id uuid, court_name text
)
language sql stable security definer set search_path = public as $$
  select m.id, m.club_id, c.name, c.slug, m.sport, m.start_at, m.end_at, m.level, m.players_needed,
         (select count(*) from match_players mp where mp.match_id = m.id)::int,
         m.status, m.note, m.organizer_id, o.name,
         exists (select 1 from match_players mp where mp.match_id = m.id and mp.profile_id = auth.uid()),
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

-- participants with names (organizer + joined), visible to organizer and participants
create or replace function match_participants(p_match uuid)
returns table (profile_id uuid, name text, level player_level, is_organizer boolean)
language sql stable security definer set search_path = public as $$
  select p.id, p.name, p.level, p.id = m.organizer_id
  from matches m
  join lateral (
    select m.organizer_id as pid union select mp.profile_id from match_players mp where mp.match_id = m.id
  ) ids on true
  join profiles p on p.id = ids.pid
  where m.id = p_match and auth.uid() is not null
    and (m.organizer_id = auth.uid() or exists (select 1 from match_players mp where mp.match_id = m.id and mp.profile_id = auth.uid()))
  order by (p.id = m.organizer_id) desc, p.name;
$$;
revoke execute on function match_participants(uuid) from public, anon;
grant execute on function match_participants(uuid) to authenticated;
