-- Paul's phone feedback (11 Nov): delete Activity items, delete own chat messages,
-- remove a finished conversation, open a booking to other players.
-- Written to be safe to re-run: every object is dropped or guarded first.

-- Activity: delete one, clear all (own rows only; RLS has no delete policy, so via RPC)
create or replace function delete_notification(p_id uuid) returns void
language sql security definer set search_path = public as $$
  delete from notifications where id = p_id and profile_id = auth.uid();
$$;
create or replace function clear_notifications() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  delete from notifications where profile_id = auth.uid();
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function delete_notification(uuid), clear_notifications() from public, anon;
grant execute on function delete_notification(uuid), clear_notifications() to authenticated;

-- Chat: a player may delete their own message; others see "message deleted" (soft delete keeps the thread readable)
alter table match_messages add column if not exists deleted_at timestamptz;
alter table match_messages drop constraint if exists match_messages_body_check;
alter table match_messages add constraint match_messages_body_check
  check (deleted_at is not null or char_length(body) between 1 and 1000);

create or replace function delete_match_message(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  update match_messages set body = '', deleted_at = now() where id = p_id and profile_id = auth.uid() and deleted_at is null;
  if not found then raise exception 'not_found'; end if;
end $$;
revoke execute on function delete_match_message(uuid) from public, anon;
grant execute on function delete_match_message(uuid) to authenticated;

-- Booking page: the live match linked to one of my bookings (or none)
create or replace function booking_match(p_booking uuid)
returns table (match_id uuid, status match_status, players_needed int, joined int, pending int, level_min int, level_max int, join_mode text)
language sql stable security definer set search_path = public as $$
  select m.id, m.status, m.players_needed,
         (select count(*) from match_players mp where mp.match_id = m.id and mp.status = 'accepted')::int,
         (select count(*) from match_players mp where mp.match_id = m.id and mp.status = 'pending')::int,
         m.level_min, m.level_max, m.join_mode
  from matches m join bookings b on b.id = m.booking_id
  where m.booking_id = p_booking and m.status <> 'cancelled' and b.player_id = auth.uid()
  limit 1;
$$;
revoke execute on function booking_match(uuid) from public, anon;
grant execute on function booking_match(uuid) to authenticated;

-- Remove a finished conversation from my own history (mine only; the match and the other players are untouched)
create table if not exists match_hidden (
  profile_id uuid not null references profiles(id) on delete cascade,
  match_id   uuid not null references matches(id) on delete cascade,
  hidden_at  timestamptz not null default now(),
  primary key (profile_id, match_id)
);
alter table match_hidden enable row level security;
drop policy if exists "match_hidden: own" on match_hidden;
create policy "match_hidden: own" on match_hidden for select to authenticated using (profile_id = auth.uid());

-- finished means the match has ended, not merely started
create or replace function hide_match(p_match uuid, p_hidden boolean default true) returns void
language plpgsql security definer set search_path = public as $$
declare m matches%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into m from matches where id = p_match;
  if not found then raise exception 'not_found'; end if;
  if not p_hidden then
    delete from match_hidden where profile_id = auth.uid() and match_id = p_match;
    return;
  end if;
  if m.status <> 'cancelled' and coalesce(m.end_at, m.start_at + interval '3 hours') > now() then
    raise exception 'match_not_finished';
  end if;
  insert into match_hidden (profile_id, match_id) values (auth.uid(), p_match) on conflict do nothing;
end $$;
revoke execute on function hide_match(uuid, boolean) from public, anon;
grant execute on function hide_match(uuid, boolean) to authenticated;

create or replace function match_is_hidden(p_match uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from match_hidden where match_id = p_match and profile_id = auth.uid());
$$;
revoke execute on function match_is_hidden(uuid) from public, anon;
grant execute on function match_is_hidden(uuid) to authenticated;

-- One definition only: deleted messages read as empty, a removed conversation reads as empty for that player.
-- p_after stays for compatibility; the client reads the whole thread so deletions propagate.
drop function if exists match_messages_list(uuid, timestamptz);
create function match_messages_list(p_match uuid, p_after timestamptz)
returns table (id uuid, profile_id uuid, name text, body text, created_at timestamptz, deleted boolean)
language sql stable security definer set search_path = public as $$
  select x.id, x.profile_id, p.name, case when x.deleted_at is null then x.body else '' end, x.created_at, x.deleted_at is not null
  from match_messages x join profiles p on p.id = x.profile_id
  where x.match_id = p_match and is_match_member(p_match) and (p_after is null or x.created_at > p_after)
    and not exists (select 1 from match_hidden h where h.match_id = p_match and h.profile_id = auth.uid())
  order by x.created_at;
$$;
revoke execute on function match_messages_list(uuid, timestamptz) from public, anon;
grant execute on function match_messages_list(uuid, timestamptz) to authenticated;

-- agenda: skip matches this player removed
create or replace function my_agenda()
returns table (kind text, id uuid, start_at timestamptz, end_at timestamptz, club_name text, club_slug text, timezone text, title text, status text, role text)
language sql stable security definer set search_path = public as $$
  (select 'booking', b.id, b.start_at, b.end_at, c.name, c.slug, c.timezone, k.name, b.status::text, 'player'
   from bookings b join clubs c on c.id = b.club_id left join courts k on k.id = b.court_id
   where auth.uid() is not null and b.player_id = auth.uid() and b.status in ('confirmed', 'cancelled', 'no_show'))
  union all
  (select 'match', m.id, m.start_at, m.end_at, c.name, c.slug, c.timezone, coalesce(s.name_en, m.sport::text) || ' match', m.status::text,
          case when m.organizer_id = auth.uid() then 'organizer' else mp.status end
   from matches m join clubs c on c.id = m.club_id
   left join sports s on s.code = m.sport
   left join match_players mp on mp.match_id = m.id and mp.profile_id = auth.uid()
   where auth.uid() is not null and (m.organizer_id = auth.uid() or mp.status in ('accepted', 'pending'))
     and not exists (select 1 from match_hidden h where h.match_id = m.id and h.profile_id = auth.uid()))
  order by start_at desc
  limit 200;
$$;
revoke execute on function my_agenda() from public, anon;
grant execute on function my_agenda() to authenticated;
